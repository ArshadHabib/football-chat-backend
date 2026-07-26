const ADMIN_KEY = "admin_arshad_habib"; // minutes before match to scrap
const MINUTES_BEFORE_MATCH_TO_SCRAP = 40;

/** Max messages returned when noLimit=true to avoid huge loads */
const MAX_ROOM_MESSAGES_LIMIT = 500;

const REG_RATE_LIMIT_PREFIX = "reg_ratelimit:";
const REG_RATE_LIMIT_TTL = 600; // 10 minutes
const BANNED_USERS_KEY = "__banned_users__";

// Cluster-wide room counter drain — written by service.js (flushMessageBatch +
// drainRoomCounters) and cleaned up by roomManager.js (deleteRoom +
// deleteAllRooms). Centralized here so writer and cleanup paths cannot drift.
const REDIS_ROOM_MSG_COUNTS = "__room_msg_counts__";
const REDIS_ROOM_LAST_ACTIVITY = "__room_last_activity__";
const REDIS_ROOM_MSG_COUNTS_DRAIN = "__room_msg_counts_drain__";
const REDIS_ROOM_LAST_ACTIVITY_DRAIN = "__room_last_activity_drain__";
const DRAIN_LOCK_KEY = "__room_counter_drainer__";

// Read-path message cache
const REDIS_MSG_CACHE_PREFIX = "__room_msg_cache__:";
const REDIS_PINNED_MSG_PREFIX = "__room_pinned__:";
const MSG_CACHE_LIMIT = 50;
const PINNED_MSG_CACHE_TTL = 30; // seconds

// IP ban set (mirrors isBanned: true records in MongoDB)
const BANNED_IPS_KEY = "__banned_ips__";

// Shared Redis key for the rooms set — used by socketHandler.js pipeline (Issue 2 fix)
const REDIS_ROOMS_SET = "__rooms__";

// Website-level user counter — one entry per distinct websiteName (replaces hGetAll on socket map)
const REDIS_WEBSITE_COUNTS = "__website_counts__";

// --- AI moderation (Gemini) tuning — see AI_MODERATION_PLAN.md.
// Behavior constants (committed, identical on every instance — no env drift).
// The API KEY is intentionally NOT here: it's a secret and lives in .env.
const GEMINI_MODEL = "gemini-3.1-flash-lite"; // gemini-2.5-flash-lite 404s for new keys
const AIMOD_CONFIDENCE_THRESHOLD = 0.85; // min confidence (0..1) to auto-ban
const AIMOD_TIMEOUT_MS = 10000; // Gemini call timeout (10s) — on timeout: no ban (fail-safe)
// Reporter limit — DEFAULTS only. The live values are cluster-synced and
// admin-editable via utils/aimod_reporter_config.js (Redis + pub/sub); these
// seed that config on first boot / when Redis has no stored value.
const AIMOD_MAX_REPORTS_PER_USER = 3; // default reports allowed per reporter per window
const AIMOD_REPORTER_WINDOW_SECONDS = 300; // default window (5 min) → "3 reports / 5 min"
const AIMOD_GLOBAL_RPM = 12; // cluster Gemini calls/minute (free-tier 3.1-flash-lite = 15)
const AIMOD_GLOBAL_RPD = 450; // cluster Gemini calls/day (free-tier 3.1-flash-lite = 500)

module.exports = {
  ADMIN_KEY,
  MINUTES_BEFORE_MATCH_TO_SCRAP,
  MAX_ROOM_MESSAGES_LIMIT,
  REG_RATE_LIMIT_PREFIX,
  REG_RATE_LIMIT_TTL,
  BANNED_USERS_KEY,
  BANNED_IPS_KEY,
  REDIS_ROOM_MSG_COUNTS,
  REDIS_ROOM_LAST_ACTIVITY,
  REDIS_ROOM_MSG_COUNTS_DRAIN,
  REDIS_ROOM_LAST_ACTIVITY_DRAIN,
  DRAIN_LOCK_KEY,
  REDIS_MSG_CACHE_PREFIX,
  REDIS_PINNED_MSG_PREFIX,
  MSG_CACHE_LIMIT,
  PINNED_MSG_CACHE_TTL,
  REDIS_ROOMS_SET,
  REDIS_WEBSITE_COUNTS,
  GEMINI_MODEL,
  AIMOD_CONFIDENCE_THRESHOLD,
  AIMOD_TIMEOUT_MS,
  AIMOD_MAX_REPORTS_PER_USER,
  AIMOD_REPORTER_WINDOW_SECONDS,
  AIMOD_GLOBAL_RPM,
  AIMOD_GLOBAL_RPD,
};
