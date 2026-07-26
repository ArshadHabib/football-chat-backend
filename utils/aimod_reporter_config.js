// Cluster-wide AI-moderation "reporter limit" config with Redis persistence +
// pub/sub. Governs how many times a single reporter (keyed by IP, username
// fallback) may trigger the AI pipeline within a rolling window — the
// SKIPPED_REPORTER_LIMIT gate in modules/moderation/service.js.
//
// Same source-of-truth pattern as utils/rate_limit_config.js, but WITHOUT the
// socket listener/onConfigChange machinery: this value is read once per report
// by the pipeline (never per message, never broadcast to chat clients), so
// there is nothing to push to sockets — exactly like utils/racism_policy.js.
//
//   - Redis is the source of truth (key: __aimod_reporter_config__, one JSON string).
//   - Each instance keeps a hot in-memory copy (read once per report — fast/free).
//   - setConfig() persists + publishes; every instance (incl. the originator)
//     applies the change via the __aimod_reporter_change__ subscription.
//
// Lifecycle (wired from server.js, mirrors rate_limit_config.js / racism_policy.js):
//   1. boot → loadFromRedis() hydrates in-memory copy (seeds DEFAULTS on first run)
//   2. boot → subscribeToChanges() listens on __aimod_reporter_change__
//   3. admin POST /set-reporter-config → setConfig(partial) → SET + publish
//   4. all instances receive the publish → applyConfig()
//
// Note on live counters: changing maxReports takes effect on the very next
// report (it's just an integer comparison). Changing windowSeconds only affects
// counters created AFTER the change — existing aimod:reporter:<id> keys keep the
// TTL they were stamped with (the pipeline uses EXPIRE ... NX), converging to
// the new window within one old-window duration. This mirrors how
// rate_limit_config behaves and is intentional (fixed-window semantics).

const { pubClient, aimodReporterSubClient } = require("@project/config/redis");
const {
  AIMOD_MAX_REPORTS_PER_USER,
  AIMOD_REPORTER_WINDOW_SECONDS,
} = require("@project/utils/const_config");

const KEY = "__aimod_reporter_config__";
const CHANNEL = "__aimod_reporter_change__";

// Defaults seeded when Redis has no value (fresh cluster) or a stored value is
// unreadable. Sourced from const_config so the committed default lives in one
// place (preserves the prior hard-coded "3 reports / 5 min" behavior).
const DEFAULTS = Object.freeze({
  maxReports: AIMOD_MAX_REPORTS_PER_USER,
  windowSeconds: AIMOD_REPORTER_WINDOW_SECONDS,
});

// Guardrails — authoritative on the server. The admin UI mirrors them for UX,
// but these are the values that actually bound what gets persisted.
const MAX_REPORTS_BOUND = 20; // reports per window
const WINDOW_BOUND = 3600; // seconds

// Hot in-memory copy. Initialized to DEFAULTS at require-time so getConfig()
// always returns valid numbers even if Redis is unreachable at boot (fail-safe:
// the pipeline still enforces the default limit and chat is unaffected).
let config = { ...DEFAULTS };

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
    maxReports:
      p.maxReports === undefined
        ? base.maxReports
        : clampInt(p.maxReports, base.maxReports, 1, MAX_REPORTS_BOUND),
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
  console.log("✅ AI reporter-limit config loaded:", config);
}

// Persist + broadcast a (partial) config change. Called only by the controller
// handling the admin's HTTP request — other instances pick up the change via
// the __aimod_reporter_change__ subscription. Applies locally first so the
// originating instance reacts immediately.
async function setConfig(partial) {
  const next = normalize(partial || {}, config);
  config = next;
  await pubClient.set(KEY, JSON.stringify(next));
  await pubClient.publish(CHANNEL, JSON.stringify(next));
  // Return the value we just computed + persisted — NOT getConfig(). The awaits
  // above yield to the event loop, during which this same process may receive
  // an earlier self-published message on aimodReporterSubClient and overwrite
  // the in-memory `config` (harmless — pub/sub is ordered, so in-memory
  // converges to the last write). Returning `next` guarantees the HTTP response
  // reflects exactly what was persisted, regardless of that timing.
  return { ...next };
}

// Cross-instance subscription. Errors in the handler are logged but never crash
// the subscriber — a malformed publish must not take down the control plane.
async function subscribeToChanges() {
  await aimodReporterSubClient.subscribe(CHANNEL, (message) => {
    try {
      applyConfig(JSON.parse(message));
    } catch (err) {
      console.error("Reporter-config pub/sub message error:", err, message);
    }
  });
}

module.exports = {
  loadFromRedis,
  subscribeToChanges,
  getConfig,
  setConfig,
  DEFAULTS,
  MAX_REPORTS_BOUND,
  WINDOW_BOUND,
};
