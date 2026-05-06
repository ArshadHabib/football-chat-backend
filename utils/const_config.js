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
};
