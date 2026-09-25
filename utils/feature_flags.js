// Cluster-wide feature flags with Redis persistence + pub/sub propagation.
//
// Design mirrors the __perf_mode__ pattern (modules/chat/controller.js +
// server.js perfSubClient.subscribe) but adds Redis persistence — without it,
// any PM2 worker that crashes and restarts would boot to the default value
// and silently diverge from the rest of the cluster until the next admin
// toggle. Source of truth is Redis; each instance keeps a hot in-memory copy
// to avoid a Redis round trip on every read (validation is checked per
// message, registration per HTTP call).
//
// Lifecycle:
//   1. server.js boot → loadFromRedis() hydrates in-memory cache from Redis,
//      seeding defaults on first run if keys are absent.
//   2. server.js boot → subscribeToChanges() starts listening on the
//      __feature_change__ Redis channel for cross-instance updates.
//   3. Admin POST /set-feature-flag → setFlag(name, value)
//      → SET feature:{name}                    (persistence)
//      → publish __feature_change__            (cross-instance fan-out)
//      → also updates this instance's cache directly so the request can
//        respond immediately even before the publish round-trips back.
//   4. All instances (including originator) receive the publish and call
//      applyFlag() which only updates the in-memory cache.

const { pubClient, featuresSubClient } = require("@project/config/redis");

const FEATURE_REGISTRATION = "registration";
const FEATURE_VALIDATION = "validation";
// AI auto-moderation master switch ("AI Ban") — gates the whole @admin
// reply-report → Gemini → auto-ban pipeline (AI_MODERATION_PLAN.md). Also
// mirrored to chat clients (join_result.aimod + aimod_changed) so the 🚩
// report button is only offered when the pipeline behind it is actually live.
const FEATURE_AIMOD = "aimod";
// Viewer-count master switch. ON = each room's own __room_show_views__ setting
// decides, exactly as before. OFF = no room shows a count under any condition,
// overriding every per-room setting. Gates both the join_result payload and the
// room_user_count_update broadcasts (see socket/roomManager.js).
const FEATURE_USERS_COUNT = "usersCount";

const KEY_PREFIX = "feature:";
const CHANNEL = "__feature_change__";
// Monotonic counter stamping each toggle with an id. Listeners whose reaction
// has a CLUSTER-WIDE side effect (the viewer-count resync) use it to elect a
// single executor per toggle: every dispatch of the same toggle carries the
// same seq, and a different toggle — including an immediate flip back — always
// gets a different one. A time-window lock cannot do both jobs at once (too
// short and the cluster double-broadcasts, too long and rapid flipping
// silently skips a resync).
const SEQ_KEY = "__feature_change_seq__";

// Defaults applied when Redis has no value for a flag (first boot of a fresh
// cluster). Once written to Redis these are never consulted again.
const DEFAULTS = Object.freeze({
  [FEATURE_REGISTRATION]: true,
  [FEATURE_VALIDATION]: false,
  [FEATURE_AIMOD]: false,
  // true preserves the pre-flag behaviour: per-room showViews stays in charge.
  [FEATURE_USERS_COUNT]: true,
});

// Hot in-memory cache. Populated by loadFromRedis() at startup and updated
// by applyFlag() whenever __feature_change__ fires.
const flags = { ...DEFAULTS };

// Listeners notified on every flag change, regardless of which instance
// triggered the change. The socket layer registers one listener here and
// reacts per flag: `validation` and `aimod` fan out to this instance's own
// sockets via io.local.emit, while `usersCount` triggers a cluster-wide
// room re-broadcast behind a single-executor election. Kept module-local so
// feature_flags.js doesn't import socket.io directly.
const listeners = new Set();

function onFlagChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notifyListeners(name, value, seq) {
  listeners.forEach((fn) => {
    try {
      fn(name, value, seq);
    } catch (err) {
      console.error("Feature flag listener error:", err);
    }
  });
}

function applyFlag(name, value) {
  if (!(name in DEFAULTS)) return; // unknown flag, ignore
  flags[name] = !!value;
}

function getFlag(name) {
  return flags[name];
}

function getAllFlags() {
  return { ...flags };
}

// Read every known flag from Redis. If a key is absent, seed it with the
// default value so subsequent reads are deterministic and the admin UI sees
// a complete state on first load.
async function loadFromRedis() {
  const names = Object.keys(DEFAULTS);
  const keys = names.map((n) => `${KEY_PREFIX}${n}`);
  const values = await pubClient.mGet(keys);
  const seedPipeline = pubClient.multi();
  let needsSeed = false;
  names.forEach((name, i) => {
    const raw = values[i];
    if (raw === null || raw === undefined) {
      flags[name] = DEFAULTS[name];
      seedPipeline.set(
        `${KEY_PREFIX}${name}`,
        DEFAULTS[name] ? "true" : "false",
      );
      needsSeed = true;
    } else {
      flags[name] = raw === "true";
    }
  });
  if (needsSeed) await seedPipeline.exec();
  console.log("✅ Feature flags loaded:", flags);
}

// Persist + broadcast a flag change. Called only by the controller handling
// the admin's HTTP request — other instances pick up the change via the
// __feature_change__ subscription.
async function setFlag(name, value) {
  if (!(name in DEFAULTS)) {
    throw new Error(`Unknown feature flag: ${name}`);
  }
  const normalized = !!value;
  applyFlag(name, normalized);
  // Stamp the toggle so the synchronous notify below and the pub/sub echo that
  // follows it carry the SAME id and are deduped downstream. Applied AFTER the
  // cache update and tolerant of failure: the token is only a dedupe hint, and
  // letting a Redis hiccup here abort the whole flag change would be a far
  // worse outcome than falling back to the coarser direction-keyed lock that
  // an absent seq already selects.
  const seq = await pubClient.incr(SEQ_KEY).catch(() => undefined);
  // Notified synchronously as well as via the publish. The duplicate is
  // deliberate and harmless (client-side handlers are idempotent setters, and
  // the resync dedupes on seq): it keeps this instance's own sockets correct
  // even if the publish below fails outright.
  notifyListeners(name, normalized, seq);
  await pubClient.set(`${KEY_PREFIX}${name}`, normalized ? "true" : "false");
  await pubClient.publish(
    CHANNEL,
    JSON.stringify({ name, value: normalized, seq }),
  );
}

// Wire up the cross-instance subscription. Idempotent — safe to call once at
// startup. Errors in the message handler are logged but do not crash the
// subscriber — a malformed publish must not take down the whole control plane.
async function subscribeToChanges() {
  await featuresSubClient.subscribe(CHANNEL, (message) => {
    try {
      const { name, value, seq } = JSON.parse(message);
      applyFlag(name, value);
      notifyListeners(name, !!value, seq);
    } catch (err) {
      console.error("Feature flag pub/sub message error:", err, message);
    }
  });
}

module.exports = {
  FEATURE_REGISTRATION,
  FEATURE_VALIDATION,
  FEATURE_AIMOD,
  FEATURE_USERS_COUNT,
  loadFromRedis,
  subscribeToChanges,
  getFlag,
  getAllFlags,
  setFlag,
  onFlagChange,
};
