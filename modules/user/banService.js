// modules/user/banService.js
//
// Shared ban ORCHESTRATION — the single source of truth for banning a user
// everywhere. Used by both the manual admin ban (modules/user/controller.js)
// and the AI auto-ban / admin-logs ban (modules/moderation/service.js), so the
// ban semantics can never drift between the two paths.
//
// Kept separate from service.js (pure Mongo data access) so the data layer
// stays free of Redis/socket concerns. Depends on userService (Mongo), Redis
// (ban sets), and roomManager (real-time broadcast). No import cycle:
// roomManager does not import the user module, and service.js imports only its
// model.

const userService = require("./service");
const { pubClient: redis } = require("@project/config/redis");
const {
  BANNED_USERS_KEY,
  BANNED_IPS_KEY,
} = require("@project/utils/const_config");
const { broadcastBanToAllRooms } = require("@project/socket/roomManager");

/**
 * Ban `name` everywhere: mark isBanned in Mongo, cascade-ban every account on
 * the same IP, add all names + the IP to the Redis ban sets, and broadcast
 * `user_updated` so connected clients lock in real time (no refresh).
 * Returns the list of banned usernames (offender + IP siblings).
 */
async function banUserEverywhere(name) {
  const user = await userService.findUserByName(name);
  await userService.updateUser(name, { isBanned: true });

  if (user?.ipAddress) {
    const cascade = await userService.banAllUsersByIp(user.ipAddress);
    const names = cascade.length > 0 ? cascade : [name];
    const pipeline = redis.multi();
    pipeline.sAdd(BANNED_USERS_KEY, names);
    pipeline.sAdd(BANNED_IPS_KEY, user.ipAddress);
    await pipeline.exec();
    await broadcastBanToAllRooms(names);
    return names;
  }

  // No stored IP (registered from localhost/unknown) — name-only ban.
  await redis.sAdd(BANNED_USERS_KEY, name);
  await broadcastBanToAllRooms([name]);
  return [name];
}

module.exports = { banUserEverywhere };
