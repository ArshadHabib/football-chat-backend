const ADMIN_KEY = "admin_arshad_habib"; // minutes before match to scrap
const MINUTES_BEFORE_MATCH_TO_SCRAP = 40;

/** Max messages returned when noLimit=true to avoid huge loads */
const MAX_ROOM_MESSAGES_LIMIT = 500;

const REG_RATE_LIMIT_PREFIX = "reg_ratelimit:";
const REG_RATE_LIMIT_TTL = 600; // 10 minutes
const BANNED_USERS_KEY = "__banned_users__";

module.exports = {
  ADMIN_KEY,
  MINUTES_BEFORE_MATCH_TO_SCRAP,
  MAX_ROOM_MESSAGES_LIMIT,
  REG_RATE_LIMIT_PREFIX,
  REG_RATE_LIMIT_TTL,
  BANNED_USERS_KEY,
};
