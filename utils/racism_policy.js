// Cluster-wide AI-moderation "racism strictness" mode with Redis persistence
// + pub/sub. Same source-of-truth pattern as utils/rate_limit_config.js and
// the __perf_mode__ setting, but carries a single enum string.
//
//   - Redis is the source of truth (key: __aimod_racism_mode__, a plain string).
//   - Each instance keeps a hot in-memory copy (read once per report by the
//     classifier — never per message — so it must just be fast/free).
//   - setMode() persists + publishes; every instance (incl. the originator)
//     applies the change via the __aimod_racism_change__ subscription.
//
// Lifecycle (wired from server.js, mirrors rate_limit_config.js):
//   1. boot → loadFromRedis() hydrates the in-memory copy (seeds DEFAULT on first run)
//   2. boot → subscribeToChanges() listens on __aimod_racism_change__
//   3. admin POST /set-racism-mode → setMode(mode) → SET + publish
//   4. all instances receive the publish → applyMode()
//
// Scope: this ONLY governs how strictly the classifier treats racism/xenophobia
// (see aiModerator.js RACISM_RULES). Religious-hatred and homophobia rules are
// independent and unaffected.

const { pubClient, racismSubClient } = require("@project/config/redis");

const KEY = "__aimod_racism_mode__";
const CHANNEL = "__aimod_racism_change__";

// strict  (A) = ban all racism incl. exclusion/stereotypes/jokes  [default]
// moderate(B) = ban slurs + dehumanization + violence; allow exclusion/jokes
// minimal (C) = ban only explicit slurs + threats/violence
const VALID = Object.freeze(["strict", "moderate", "minimal"]);
const DEFAULT = "strict";

// Hot in-memory copy. Populated by loadFromRedis() at startup and updated by
// applyMode() whenever __aimod_racism_change__ fires.
let mode = DEFAULT;

function isValid(m) {
  return typeof m === "string" && VALID.includes(m);
}

function applyMode(next) {
  if (isValid(next)) mode = next; // ignore malformed publishes — keep last good
}

function getMode() {
  return mode;
}

// Read the mode from Redis. If absent/unreadable/invalid, seed DEFAULT so
// subsequent reads are deterministic and the admin UI sees a complete state.
async function loadFromRedis() {
  const raw = await pubClient.get(KEY);
  if (!isValid(raw)) {
    mode = DEFAULT;
    await pubClient.set(KEY, DEFAULT);
  } else {
    mode = raw;
  }
  console.log("✅ AI racism mode loaded:", mode);
}

// Persist + broadcast a mode change. Called only by the controller handling the
// admin's HTTP request — other instances pick it up via the subscription.
// Applies locally first so the originating instance reacts immediately.
async function setMode(next) {
  if (!isValid(next)) {
    throw new Error(`Invalid racism mode: ${next}. Expected one of ${VALID.join(", ")}`);
  }
  mode = next;
  await pubClient.set(KEY, next);
  await pubClient.publish(CHANNEL, next);
  return mode;
}

// Cross-instance subscription. Errors in the handler are logged but never crash
// the subscriber — a malformed publish must not take down the control plane.
async function subscribeToChanges() {
  await racismSubClient.subscribe(CHANNEL, (message) => {
    try {
      applyMode(message);
    } catch (err) {
      console.error("Racism mode pub/sub message error:", err, message);
    }
  });
}

module.exports = {
  loadFromRedis,
  subscribeToChanges,
  getMode,
  setMode,
  VALID,
  DEFAULT,
};
