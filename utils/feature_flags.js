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

const KEY_PREFIX = "feature:";
const CHANNEL = "__feature_change__";

// Defaults applied when Redis has no value for a flag (first boot of a fresh
// cluster). Once written to Redis these are never consulted again.
const DEFAULTS = Object.freeze({
  [FEATURE_REGISTRATION]: true,
  [FEATURE_VALIDATION]: false,
});

// Hot in-memory cache. Populated by loadFromRedis() at startup and updated
// by applyFlag() whenever __feature_change__ fires.
const flags = { ...DEFAULTS };

// Listeners notified on every flag change, regardless of which instance
// triggered the change. The socket layer registers a listener here to
// broadcast validation flips to its connected sockets via io.local.emit.
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
      seedPipeline.set(`${KEY_PREFIX}${name}`, DEFAULTS[name] ? "true" : "false");
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
  loadFromRedis,
  subscribeToChanges,
  getFlag,
  getAllFlags,
  setFlag,
  onFlagChange,
};
