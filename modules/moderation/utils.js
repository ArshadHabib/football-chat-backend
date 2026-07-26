// modules/moderation/utils.js
//
// Pure presentation helpers for the AI-moderation report-outcome announcements
// (plan §22). No side effects, no I/O — these only build strings/objects that
// service.js hands to emitAdminMessage. Kept out of service.js so the pipeline
// file owns orchestration only, and so the message wording (the most-tweaked
// part) lives in one isolated, unit-testable place.

// Human-readable phrase per violation category, used in the public ban
// announcement. Deliberately the category, not the raw offending content.
const REASON_PHRASE = {
  racism: "racism",
  religious_hatred: "religious hatred",
  hate_speech: "hate speech",
  harassment: "harassment",
};

// --- tiny formatters (private) ---------------------------------------------
function by(name) {
  return name ? ` (reported by "${name}")` : "";
}
function pct(c) {
  return `${Math.round((Number(c) || 0) * 100)}%`;
}
function humanizeWindow(s) {
  if (s % 60 === 0) {
    const m = s / 60;
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  return `${s} second${s === 1 ? "" : "s"}`;
}

// Reply-quote shape spread by emitAdminMessage (mirrors the client replyTo).
function reportReplyTo(o) {
  return {
    messageId: String(o._id),
    senderName: String(o.senderName || "").slice(0, 50),
    contentSnippet: String(o.messageContent || "").slice(0, 140),
    isAdmin: false,
  };
}

// Message builder per outcome. `c` (context) carries whatever the call site in
// service.js has in scope: reporterName, original, verdict, maxReports,
// windowSeconds. Missing fields degrade gracefully (by()/reason guards).
const OUTCOME = {
  BANNED: (c) => {
    const phrase = REASON_PHRASE[c.verdict?.category] || "hate speech";
    const reason = String(c.verdict?.reason || "").trim();
    return `🚫 User "${c.original.senderName}" has been banned from chat for ${phrase} (${pct(c.verdict.confidence)})${reason ? `: ${reason}` : ""}${by(c.reporterName)}`;
  },
  NEEDS_REVIEW: (c) =>
    `🔍 Above chat has been flagged for admin review.${by(c.reporterName)}`,
  DISMISSED: (c) =>
    `✅ Above chat was reviewed — no violation found, no action taken.${by(c.reporterName)}`,
  DISMISSED_CACHED: (c) =>
    `💬 Above chat was already reviewed recently — no further action.${by(c.reporterName)}`,
  ALREADY_BANNED: (c) =>
    `💬 This user is already banned — no further action.${by(c.reporterName)}`,
  SELF_REPORT: (c) =>
    c.reporterName
      ? `💬 User "${c.reporterName}" can't report their own message.`
      : `💬 A user can't report their own message.`,
  TARGET_ADMIN: (c) =>
    `💬 Admin messages can't be reported.${by(c.reporterName)}`,
  GLOBAL_BUDGET: (c) =>
    `⏳ Above chat couldn't be reviewed right now — moderation is busy, try again shortly.${by(c.reporterName)}`,
  ERROR_AI: (c) =>
    `⚠️ Above chat couldn't be reviewed due to an error — no action taken.${by(c.reporterName)}`,
  ERROR_BAN: (c) =>
    `⚠️ Above chat: violation confirmed but the ban couldn't be completed — an admin will follow up.${by(c.reporterName)}`,
  REPORTER_LIMIT: (c) =>
    `⏳ ${c.reporterName ? `User "${c.reporterName}" report` : "Report"} limit reached (${c.maxReports} per ${humanizeWindow(c.windowSeconds)}).`,
  NOT_FOUND: (c) =>
    `⚠️ Reported message could not be found.${by(c.reporterName)}`,
};

// Outcomes that reply-quote the reported message. The two omitted
// (REPORTER_LIMIT, NOT_FOUND) have no resolved message to quote.
const QUOTED = new Set([
  "BANNED",
  "NEEDS_REVIEW",
  "DISMISSED",
  "DISMISSED_CACHED",
  "ALREADY_BANNED",
  "SELF_REPORT",
  "TARGET_ADMIN",
  "GLOBAL_BUDGET",
  "ERROR_AI",
  "ERROR_BAN",
]);

module.exports = { OUTCOME, QUOTED, reportReplyTo, REASON_PHRASE };
