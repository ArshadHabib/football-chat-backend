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
// reacts per flag, always against its OWN sockets: `validation` and `aimod`
// via io.local.emit, `usersCount` via a per-room io.local.to(room) re-broadcast.
// Kept module-local so feature_flags.js doesn't import socket.io directly.
const listeners = new Set();

function onFlagChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notifyListeners(name, value) {
  listeners.forEach((fn) => {
    try {
      fn(name, value);
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

// Whether the boot-time load has completed. The first call happens at boot,
// before the server starts listening: no socket exists yet, so there is nothing
// to repair — but the listeners ARE already registered (setupSocketHandlers runs
// first), so notifying would run their side effects for nothing. For usersCount
// that means a full sync pass on every instance boot: Redis reads plus clearing
// every room's __room_last_broadcast__ entry. Every call after the first is a
// re-hydrate following a Redis reconnect, and that is where notifying matters.
let hydrated = false;

// Read every known flag from Redis. If a key is absent, seed it with the
// default value so subsequent reads are deterministic and the admin UI sees
// a complete state on first load.
async function loadFromRedis() {
  const names = Object.keys(DEFAULTS);
  const keys = names.map((n) => `${KEY_PREFIX}${n}`);
  const values = await pubClient.mGet(keys);
  const seedPipeline = pubClient.multi();
  let needsSeed = false;
  const changed = [];
  names.forEach((name, i) => {
    const previous = flags[name];
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
    if (flags[name] !== previous) changed.push(name);
  });
  // On a re-hydrate, notify for anything that actually moved: an instance that
  // missed a publish while its subscriber was down would otherwise converge its
  // cache silently while its share of the sockets stayed on the old value
  // forever, with nothing periodically reconciling them. Skipped on the boot
  // load — see `hydrated` above.
  //
  // Done BEFORE the seed write below, not after it. The cache has already moved
  // by this point; if the seed write then threw, a notify placed after it would
  // never run, and every later re-hydrate would compare Redis against the
  // already-updated cache, see no change, and never notify either — leaving
  // this instance's sockets stale for good.
  if (hydrated) changed.forEach((name) => notifyListeners(name, flags[name]));
  hydrated = true;
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
  notifyListeners(name, normalized);
  await pubClient.set(`${KEY_PREFIX}${name}`, normalized ? "true" : "false");
  await pubClient.publish(CHANNEL, JSON.stringify({ name, value: normalized }));
}

// Wire up the cross-instance subscription. Idempotent — safe to call once at
// startup. Errors in the message handler are logged but do not crash the
// subscriber — a malformed publish must not take down the whole control plane.
async function subscribeToChanges() {
  await featuresSubClient.subscribe(CHANNEL, (message) => {
    try {
      const { name, value } = JSON.parse(message);
      applyFlag(name, value);
      notifyListeners(name, !!value);
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
