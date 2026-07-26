// modules/moderation/service.js
//
// AI auto-moderation pipeline (AI_MODERATION_PLAN.md).
//
// Entry point is handleReport(), fired-and-forgotten from the room_message
// socket handler AFTER the normal broadcast+persist — the hot path measured
// in PERF_REPORT.md is untouched. A "report" is any user reply that mentions
// @admin (Option B trigger, decision §11 Q6) targeting another message.
//
// Guard/flow order (cheap → expensive; each step cannot waste a more
// expensive resource than the ones already passed):
//
//   flag → availability → reporter cooldown → fetch original (cache→Mongo,
//   room-scoped) → target guards (not-found / no-name / admin / self /
//   already-banned) → verdict cache (repeat report = no-op, NEVER re-ban) →
//   cluster lock → global RPM/RPD budget → Gemini classify → act → release lock
//
// Every report — acted on or skipped — lands in the ModerationLog audit
// collection so a human can always reconstruct what the AI did and why.

const mongoose = require("mongoose");
const { pubClient: redis } = require("@project/config/redis");
const {
  BANNED_USERS_KEY,
  REDIS_MSG_CACHE_PREFIX,
  AIMOD_CONFIDENCE_THRESHOLD: CONFIDENCE_THRESHOLD,
  AIMOD_GLOBAL_RPM: GLOBAL_RPM,
  AIMOD_GLOBAL_RPD: GLOBAL_RPD,
} = require("@project/utils/const_config");
const featureFlags = require("@project/utils/feature_flags");
const userService = require("@project/modules/user/service");
const { banUserEverywhere } = require("@project/modules/user/banService");
const { getIO } = require("@project/socket/roomManager");
const { saveChatMessageService } = require("@project/modules/chat/service");
const MessageModel = require("@project/modules/chat/messageModel");
const { OBJECT_ID_REGEX } = require("@project/utils/messageValidation");
const racismPolicy = require("@project/utils/racism_policy");
const reporterConfig = require("@project/utils/aimod_reporter_config");
const { OUTCOME, QUOTED, reportReplyTo } = require("./utils");
const ModerationLog = require("./model");
const aiModerator = require("./aiModerator");

// Config constants (CONFIDENCE_THRESHOLD, GLOBAL_RPM, GLOBAL_RPD) come from
// utils/const_config.js — committed + identical on every instance. Only the
// Gemini API KEY is env-sourced (secret). See AI_MODERATION_PLAN.md §3.3.
// The reporter limit (maxReports / windowSeconds) is NOT a constant here: it's
// a cluster-synced, admin-editable value read once per report from
// utils/aimod_reporter_config.js (defaults still seeded from const_config).

// Redis keys (plan §5.8). Prefixed "aimod:" — distinct from the "__x__"
// infra keys and the "ratelimit:"/"reg_ratelimit:" per-IP counters.
const LOCK_PREFIX = "aimod:lock:"; // NX PX — one judge per message, cluster-wide
const VERDICT_PREFIX = "aimod:verdict:"; // judged verdict cache
const REPORTER_PREFIX = "aimod:reporter:"; // per-reporter cooldown counter
const GLOBAL_RPM_KEY = "aimod:global_rpm"; // cluster calls/minute
const GLOBAL_RPD_KEY = "aimod:global_rpd"; // cluster calls/day (free tier)

const LOCK_TTL_MS = 120000; // covers Gemini call + retry with margin
const VERDICT_TTL_SECONDS = 86400; // 24h

// Option B trigger: "@admin" as a standalone mention anywhere in the reply.
// (?:^|[^\w.@-]) rejects prefixes like "email@admin" / "x.@admin";
// \b after "admin" rejects "@administrator" / "@adminfake".
const REPORT_REGEX = /(?:^|[^\w.@-])@admin\b/i;

const MAX_CONTEXT_MESSAGES = 5;


// ---------------------------------------------------------------------------
// Detection — called inline in the room_message handler; must stay trivial.
// The messageId shape is already guaranteed by sanitizeReplyTo at the call
// site; the regex here is the only real work.
// ---------------------------------------------------------------------------
function detectAdminReport({ messageContent, replyTo }) {
  return !!(
    typeof messageContent === "string" &&
    REPORT_REGEX.test(messageContent) &&
    replyTo &&
    typeof replyTo.messageId === "string" &&
    OBJECT_ID_REGEX.test(replyTo.messageId)
  );
}

// ---------------------------------------------------------------------------
// Audit logging — fire-and-forget, never blocks or throws into the pipeline
// ---------------------------------------------------------------------------
function logModeration(fields) {
  ModerationLog.create(fields).catch((err) =>
    console.error("Moderation log write error:", err.message),
  );
}

// ---------------------------------------------------------------------------
// Original-message fetch — Redis sorted-set cache first, Mongo fallback.
// BOTH paths are room-scoped: the cache key is per-room, and the Mongo
// fallback filters on roomId so a client-forged replyTo.messageId can never
// pull a message from a DIFFERENT room (would otherwise enable cross-room
// bans + quoting foreign content into this room's announcement).
// Returns { original, cacheMessages } — cacheMessages reused for sender
// context without a second ZRANGE.
// ---------------------------------------------------------------------------
async function fetchOriginalMessage(roomId, messageId) {
  const wanted = messageId.toLowerCase();
  const cacheMessages = [];
  try {
    const cached = await redis.zRange(
      `${REDIS_MSG_CACHE_PREFIX}${roomId}`,
      0,
      -1,
    );
    for (const raw of cached) {
      try {
        cacheMessages.push(JSON.parse(raw));
      } catch {
        /* skip corrupt entry */
      }
    }
  } catch (err) {
    console.error("aimod cache read error:", err.message);
  }

  let original =
    cacheMessages.find((m) => String(m._id).toLowerCase() === wanted) || null;

  if (!original) {
    // roomId-scoped — never resolve a message from another room.
    original = await MessageModel.findOne({ _id: messageId, roomId })
      .lean()
      .catch(() => null);
  }
  return { original, cacheMessages };
}

// The ban tool is the shared `banUserEverywhere` (modules/user/banService.js)
// — name + IP cascade + Redis ban sets + real-time broadcast — the single
// source of truth used by both the manual admin ban and this AI path.

// ---------------------------------------------------------------------------
// Single source of truth for an "Admin" room announcement: broadcast + persist
// with the exact shape every client renders (red name + crown, optional quote),
// same as the admin_room_message handler. Used by both the AI ban announcement
// and the manual admin ban/unban announcement.
// ---------------------------------------------------------------------------
function emitAdminMessage(io, roomId, messageContent, replyTo) {
  if (!io || !roomId) return;
  const msgId = new mongoose.Types.ObjectId();
  io.to(roomId).emit("room_message", {
    _id: msgId.toString(),
    senderName: "Admin",
    messageContent,
    roomId,
    isAdmin: true,
    isPinned: false,
    timestamp: new Date().toISOString(),
    ...(replyTo && { replyTo }),
  });
  saveChatMessageService(roomId, {
    _id: msgId,
    senderName: "Admin",
    senderId: "ai-moderator",
    messageContent,
    messageType: "room_message",
    isAdmin: true,
    ...(replyTo && { replyTo }),
  }).catch((err) => console.error("aimod announce save error:", err.message));
}

// ---------------------------------------------------------------------------
// Report-outcome announcements (plan §22). EVERY report outcome posts a public
// "Admin" room message through the SAME emitAdminMessage path as the ban — no
// new event, sender, or transport. The wording table (OUTCOME), the QUOTED set,
// and the pure formatters live in ./utils (presentation only); this file keeps
// just the side-effecting glue below.
// ---------------------------------------------------------------------------
// Build the outcome text and post it via the shared admin-message path. Attaches
// the reply-quote only for QUOTED outcomes that actually have the message.
// Reuses emitAdminMessage, so it inherits the null-io/room guard and the
// fire-and-forget persist — no new failure path on the report pipeline.
function announceOutcome(io, roomId, outcome, ctx) {
  const build = OUTCOME[outcome];
  if (!build) return;
  const replyTo =
    QUOTED.has(outcome) && ctx.original ? reportReplyTo(ctx.original) : undefined;
  emitAdminMessage(io, roomId, build(ctx), replyTo);
}

// ---------------------------------------------------------------------------
// Quiet heads-up to online admins on low-confidence violations (decision §11
// Q4). Rides the existing __admins__ socket.io room + admin_custom_event —
// the admin panel already listens to that event.
// ---------------------------------------------------------------------------
function notifyAdminsNeedsReview(io, roomId, original, verdict) {
  io.to("__admins__").emit("admin_custom_event", {
    eventType: "system_alert",
    alertType: "aimod_needs_review",
    roomId,
    reportedUser: original.senderName,
    reportedMessageId: String(original._id),
    contentSnippet: String(original.messageContent || "").slice(0, 140),
    verdict,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Fresh verdict → action. Only ever called with a just-computed verdict (the
// cache path deliberately does NOT re-act — see handleReport), so a manual
// unban is never reverted by a stale cached verdict.
// ---------------------------------------------------------------------------
// Returns true if the verdict should be cached (the action completed), false
// if it must NOT be cached so a later report retries — currently only when the
// ban itself failed (transient Mongo/Redis error): we don't want to serve a
// cached "violation" for 24h while the offender is actually still unbanned.
async function actOnVerdict({ io, roomId, original, verdict, logBase }) {
  const reporterName = logBase.reporterName;
  if (verdict.violation && verdict.confidence >= CONFIDENCE_THRESHOLD) {
    try {
      await banUserEverywhere(original.senderName);
    } catch (err) {
      console.error("aimod ban error:", err.message);
      announceOutcome(io, roomId, "ERROR_BAN", { reporterName, original });
      logModeration({ ...logBase, verdict, action: "ERROR", error: `ban_failed: ${err.message}` });
      return false; // ban failed → do NOT cache → next report retries
    }
    announceOutcome(io, roomId, "BANNED", { reporterName, original, verdict });
    logModeration({ ...logBase, verdict, action: "BANNED" });
    return true;
  }
  if (verdict.violation) {
    notifyAdminsNeedsReview(io, roomId, original, verdict);
    announceOutcome(io, roomId, "NEEDS_REVIEW", { reporterName, original });
    logModeration({ ...logBase, verdict, action: "NEEDS_REVIEW" });
    return true;
  }
  announceOutcome(io, roomId, "DISMISSED", { reporterName, original });
  logModeration({ ...logBase, verdict, action: "DISMISSED" });
  return true;
}

// ---------------------------------------------------------------------------
// Main pipeline — fire-and-forget from socketHandler; never throws upward.
// ---------------------------------------------------------------------------
async function handleReport({ io, roomId, reporterName, reporterIp, replyTo }) {
  // Kill switch + availability — cheapest checks first, no Redis touched.
  if (!featureFlags.getFlag(featureFlags.FEATURE_AIMOD)) return;
  if (!aiModerator.isAvailable()) return;

  const messageId = replyTo.messageId.toLowerCase();
  // Snapshot the racism strictness once for this whole report — used for the
  // verdict cache key AND recorded on every audit row (so the log shows which
  // policy was active when the report was judged). Verdict cache is keyed by
  // this mode so switching the mode makes previously-cached verdicts miss →
  // messages get re-judged under the new policy instead of serving a stale
  // verdict for up to 24h. Old-mode keys expire naturally via TTL.
  const racismMode = racismPolicy.getMode();
  const verdictKey = `${VERDICT_PREFIX}${racismMode}:${messageId}`;
  const logBase = {
    roomId,
    reportedMessageId: messageId,
    reporterName: reporterName || "",
    reporterIp: reporterIp || "",
    model: aiModerator.MODEL,
    racismMode,
  };

  // Reporter cooldown — stops one client from spamming reports. Keyed by IP
  // when available (rename-proof), username otherwise. INCR + EXPIRE NX in a
  // single pipeline so the counter can never end up without a TTL.
  //
  // maxReports / windowSeconds are read once here from the cluster-synced,
  // admin-editable reporter config (in-memory copy — no Redis round-trip).
  // Changing maxReports takes effect on the next report; changing windowSeconds
  // only affects NEW counters (existing keys keep their stamped TTL because of
  // EXPIRE ... NX), converging within one old window — same fixed-window
  // behavior as rate_limit_config.
  const { maxReports, windowSeconds } = reporterConfig.getConfig();
  const reporterKey = `${REPORTER_PREFIX}${reporterIp || reporterName || "unknown"}`;
  const [reportCount] = await redis
    .multi()
    .incr(reporterKey)
    .expire(reporterKey, windowSeconds, "NX")
    .exec();
  if (reportCount > maxReports) {
    announceOutcome(io, roomId, "REPORTER_LIMIT", {
      reporterName,
      maxReports,
      windowSeconds,
    });
    logModeration({ ...logBase, action: "SKIPPED_REPORTER_LIMIT" });
    return;
  }

  // Fetch the ORIGINAL message server-side (room-scoped). Done BEFORE the
  // cluster lock and budget so that not-found / guard skips never hold a lock
  // or burn a Gemini budget unit. The client-supplied contentSnippet is
  // display-only and never used as evidence (plan §6 case 7).
  const { original, cacheMessages } = await fetchOriginalMessage(roomId, messageId);
  if (!original) {
    announceOutcome(io, roomId, "NOT_FOUND", { reporterName });
    logModeration({ ...logBase, action: "SKIPPED_NOT_FOUND" });
    return;
  }

  logBase.reportedUser = original.senderName || "";
  logBase.reportedContent = original.messageContent || "";

  // Target guards. senderName can be absent (room_message doesn't validate it
  // and JSON.stringify drops undefined fields) — treat a nameless target as
  // unactionable rather than letting undefined reach sIsMember/findUserByName.
  if (!original.senderName || typeof original.senderName !== "string") {
    // original exists but has no usable sender — treated as not-found; NOT_FOUND
    // is not a QUOTED outcome, so we deliberately don't pass `original` (no quote).
    announceOutcome(io, roomId, "NOT_FOUND", { reporterName });
    logModeration({ ...logBase, action: "SKIPPED_NOT_FOUND" });
    return;
  }
  if (original.isAdmin || original.senderName === "Admin") {
    announceOutcome(io, roomId, "TARGET_ADMIN", { reporterName, original });
    logModeration({ ...logBase, action: "SKIPPED_TARGET_ADMIN" });
    return;
  }
  if (original.senderName === reporterName) {
    announceOutcome(io, roomId, "SELF_REPORT", { reporterName, original });
    logModeration({ ...logBase, action: "SKIPPED_SELF_REPORT" });
    return;
  }
  if (await redis.sIsMember(BANNED_USERS_KEY, original.senderName)) {
    announceOutcome(io, roomId, "ALREADY_BANNED", { reporterName, original });
    logModeration({ ...logBase, action: "SKIPPED_ALREADY_BANNED" });
    return;
  }

  // Verdict cache — this message was already judged within 24h. A repeat
  // report is a NO-OP: the first judgment already banned/announced/alerted.
  // We deliberately do NOT re-run actOnVerdict, so a manual admin unban is
  // never reverted by a stale cached violation, and NEEDS_REVIEW alerts don't
  // re-fire on every repeat report.
  const cachedRaw = await redis.get(verdictKey);
  if (cachedRaw) {
    announceOutcome(io, roomId, "DISMISSED_CACHED", { reporterName, original });
    logModeration({ ...logBase, action: "DISMISSED", fromCache: true });
    return;
  }

  // Cluster dedupe — exactly one instance judges each message. Losing the
  // race is silent by design: the winner writes the audit log entry. The
  // lock is released in the finally below; the verdict cache is the durable
  // idempotency guard once a call succeeds.
  const gotLock = await redis.set(`${LOCK_PREFIX}${messageId}`, "1", {
    NX: true,
    PX: LOCK_TTL_MS,
  });
  if (gotLock !== "OK") return;

  try {
    // Global Gemini budget — free-tier protection (RPM + RPD), cluster-wide.
    // Counted here, immediately before the call, AFTER all skip paths — so no
    // skipped report ever consumes quota. Both counters INCR+EXPIRE-NX in a
    // single pipeline (1 RTT, and each counter always carries a TTL).
    const budget = await redis
      .multi()
      .incr(GLOBAL_RPM_KEY)
      .expire(GLOBAL_RPM_KEY, 60, "NX")
      .incr(GLOBAL_RPD_KEY)
      .expire(GLOBAL_RPD_KEY, 86400, "NX")
      .exec();
    const rpm = budget[0];
    const rpd = budget[2];
    if (rpm > GLOBAL_RPM || rpd > GLOBAL_RPD) {
      announceOutcome(io, roomId, "GLOBAL_BUDGET", { reporterName, original });
      logModeration({ ...logBase, action: "SKIPPED_GLOBAL_BUDGET" });
      return; // lock released in finally → retryable when budget frees
    }

    // Context: the same sender's other recent messages in this room, oldest
    // first, capped. Helps Gemini judge repeat offenders and disambiguate.
    const contextMessages = cacheMessages
      .filter(
        (m) =>
          m.senderName === original.senderName &&
          String(m._id).toLowerCase() !== messageId &&
          typeof m.messageContent === "string" &&
          m.messageContent.length > 0,
      )
      .slice(-MAX_CONTEXT_MESSAGES)
      .map((m) => m.messageContent);

    // Judge
    const startedAt = Date.now();
    const result = await aiModerator.classify({
      reportedText: original.messageContent,
      senderName: original.senderName,
      contextMessages,
    });
    const latencyMs = Date.now() - startedAt;

    if (!result.ok) {
      // Fail-safe: no verdict → no ban, ever. No verdict cached → a later
      // report retries once the API recovers (lock released in finally).
      announceOutcome(io, roomId, "ERROR_AI", { reporterName, original });
      logModeration({ ...logBase, action: "ERROR", error: result.error, latencyMs });
      return;
    }

    // Act first, then cache — but only if the action completed. A failed ban
    // returns false so we do NOT cache, letting a later report retry instead
    // of serving a 24h "violation" verdict while the user is still unbanned.
    // The cache is written before the finally releases the lock, so there is
    // no window where the lock is gone but the verdict isn't cached; repeat
    // reports either lose the lock (in-flight) or hit the cache (after).
    const shouldCache = await actOnVerdict({
      io,
      roomId,
      original,
      verdict: result.verdict,
      logBase: { ...logBase, latencyMs },
    });
    if (shouldCache) {
      await redis
        .set(verdictKey, JSON.stringify(result.verdict), {
          EX: VERDICT_TTL_SECONDS,
        })
        .catch(() => {});
    }
  } finally {
    await redis.del(`${LOCK_PREFIX}${messageId}`).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Admin-initiated ban/unban from the moderation-logs dialog. The dialog has no
// per-room socket, so we replicate the chat-panel technique SERVER-side:
//   1. flip ban state (ban reuses banUserEverywhere → name + IP cascade in
//      Mongo + Redis; unban is single-user, mirroring the manual flow)
//   2. real-time `user_updated` broadcast (global io.emit, adapter-fanned to
//      all instances) → a connected user locks/unlocks WITHOUT a refresh. The
//      ban broadcast happens inside banUserEverywhere; the unban one here.
//   3. an "Admin" announcement posted into the report's room, same wording as
//      the manual chat-panel popover.
// ---------------------------------------------------------------------------
function announceAdminAction(io, roomId, name, isBanned) {
  const messageContent = `User "${name}" has been ${isBanned ? "banned" : "unbanned"} from chat.`;
  emitAdminMessage(io, roomId, messageContent);
}

async function applyAdminBan({ name, isBanned, roomId }) {
  if (!name || typeof name !== "string") throw new Error("name required");
  const io = getIO();

  if (isBanned) {
    // name + IP cascade + Redis/Mongo + real-time user_updated:true broadcast
    await banUserEverywhere(name);
  } else {
    // Single-user unban (mirrors the manual flow — does not touch IP siblings)
    await userService.updateUser(name, { isBanned: false });
    await redis.sRem(BANNED_USERS_KEY, name);
    if (io) {
      io.emit("user_updated", {
        name,
        isBanned: false,
        updatedBy: "admin",
        timestamp: new Date().toISOString(),
        eventType: "user_updated",
      });
    }
  }

  if (io && roomId) announceAdminAction(io, roomId, name, isBanned);
}

module.exports = {
  detectAdminReport,
  handleReport,
  applyAdminBan,
};
