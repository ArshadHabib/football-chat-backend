// Cluster-wide message rate-limit config with Redis persistence + pub/sub.
//
// Same source-of-truth pattern as utils/feature_flags.js, but carries a small
// object { enabled, max, windowSeconds } instead of boolean flags:
//   - Redis is the source of truth (key: __rate_limit_config__, a single JSON string).
//   - Each instance keeps a hot in-memory copy (read per message — must be fast).
//   - setConfig() persists + publishes; every instance (incl. the originator)
//     applies the change via the __rate_limit_change__ subscription.
//   - onConfigChange() lets the socket layer broadcast to its sockets without
//     this module importing socket.io.
//
// Lifecycle (mirrors feature_flags.js, wired from server.js):
//   1. boot → loadFromRedis() hydrates in-memory copy (seeds DEFAULTS on first run)
//   2. boot → subscribeToChanges() listens on __rate_limit_change__
//   3. admin POST /set-rate-limit-config → setConfig(partial)
//        → applies locally + notifies listeners synchronously
//        → SET __rate_limit_config__        (persistence)
//        → publish __rate_limit_change__ (cross-instance fan-out)
//   4. all instances (incl. originator) receive the publish → applyConfig() +
//      notifyListeners().

const { pubClient, rateLimitSubClient } = require("@project/config/redis");

// Deliberately NOT under the "ratelimit:" prefix — that namespace holds the
// per-IP counters (`ratelimit:{ip}`) written by the room_message pipeline in
// socketHandler.js. Keeping the config under the __...__ control-plane
// convention (cf. __perf_mode_current__) avoids any overlap with those keys.
const KEY = "__rate_limit_config__";
const CHANNEL = "__rate_limit_change__";

// Defaults applied when Redis has no value (first boot of a fresh cluster) or
// when a stored value is unreadable. Enabled by default preserves the prior
// always-on 1-message / 5-second behavior.
const DEFAULTS = Object.freeze({ enabled: true, max: 1, windowSeconds: 5 });

// Guardrails — authoritative on the server. The admin UI mirrors them for UX,
// but these are the values that actually bound what gets persisted.
const MAX_BOUND = 100; // messages
const WINDOW_BOUND = 3600; // seconds

// Hot in-memory copy. Populated by loadFromRedis() at startup and updated by
// applyConfig() whenever __rate_limit_change__ fires.
let config = { ...DEFAULTS };

// Listeners notified on every change, regardless of which instance triggered
// it. The socket layer registers one to broadcast to its connected sockets via
// io.local.emit. Kept module-local so this file doesn't import socket.io.
const listeners = new Set();

function onConfigChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notifyListeners(cfg) {
  listeners.forEach((fn) => {
    try {
      fn(cfg);
    } catch (err) {
      console.error("Rate-limit listener error:", err);
    }
  });
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Coerce an arbitrary (possibly partial) input into a fully valid config,
// merging onto a base (current config by default). Absent fields keep the base
// value; present numeric fields are clamped to their bounds.
function normalize(partial, base = config) {
  const p = partial || {};
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    max: p.max === undefined ? base.max : clampInt(p.max, base.max, 1, MAX_BOUND),
    windowSeconds:
      p.windowSeconds === undefined
        ? base.windowSeconds
        : clampInt(p.windowSeconds, base.windowSeconds, 1, WINDOW_BOUND),
  };
}

// Apply a full config object (from Redis load or a pub/sub message). Merges onto
// DEFAULTS so any missing field is filled deterministically.
function applyConfig(next) {
  config = normalize(next, DEFAULTS);
}

function getConfig() {
  return { ...config };
}

// Read the config from Redis. If the key is absent (or unreadable), seed it with
// DEFAULTS so subsequent reads are deterministic and the admin UI sees a
// complete state on first load.
async function loadFromRedis() {
  const raw = await pubClient.get(KEY);
  if (raw === null || raw === undefined) {
    config = { ...DEFAULTS };
    await pubClient.set(KEY, JSON.stringify(config));
  } else {
    try {
      applyConfig(JSON.parse(raw));
    } catch {
      config = { ...DEFAULTS };
      await pubClient.set(KEY, JSON.stringify(config));
    }
  }
  console.log("✅ Rate-limit config loaded:", config);
}

// Persist + broadcast a (partial) config change. Called only by the controller
// handling the admin's HTTP request — other instances pick up the change via
// the __rate_limit_change__ subscription. Notifies local listeners synchronously
// first so the originating instance reacts immediately, matching how the cache
// is updated synchronously here.
async function setConfig(partial) {
  const next = normalize(partial || {}, config);
  config = next;
  notifyListeners(getConfig());
  await pubClient.set(KEY, JSON.stringify(next));
  await pubClient.publish(CHANNEL, JSON.stringify(next));
  return getConfig();
}

// Wire up the cross-instance subscription. Errors in the message handler are
// logged but never crash the subscriber — a malformed publish must not take
// down the control plane.
async function subscribeToChanges() {
  await rateLimitSubClient.subscribe(CHANNEL, (message) => {
    try {
      applyConfig(JSON.parse(message));
      notifyListeners(getConfig());
    } catch (err) {
      console.error("Rate-limit pub/sub message error:", err, message);
    }
  });
}

module.exports = {
  loadFromRedis,
  subscribeToChanges,
  getConfig,
  setConfig,
  onConfigChange,
  DEFAULTS,
};
