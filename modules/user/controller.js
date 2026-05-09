const userService = require("./service");
const { sendResponse, sendError, generateToken } = require("@project/utils");
const { broadcastBanToAllRooms } = require("@project/socket/roomManager");
const { pubClient: redis } = require("@project/config/redis");
const { REG_RATE_LIMIT_PREFIX, REG_RATE_LIMIT_TTL, BANNED_USERS_KEY, BANNED_IPS_KEY } = require("@project/utils/const_config");

async function registerUserController(req, res) {
  // inComingClientIp (client-supplied via ipify.org) is no longer trusted —
  // a scripted client can spoof it to bypass per-IP rate limit, IP ban, and
  // banAllUsersByIp cascade. Use req.clientIp (set by attachClientIp from
  // req.ip, which Express resolves from nginx's X-Forwarded-For under
  // `trust proxy: 1`) as the only source of truth.
  // const { name, clientIp, inComingClientIp } = req?.body;
  const { name, clientIp } = req?.body;
  try {
    // const ip = inComingClientIp || clientIp;
    const ip = clientIp;

    // 1️⃣ IP ban check via Redis (warm at startup, updated on every ban action)
    if (ip) {
      const ipBanned = await redis.sIsMember(BANNED_IPS_KEY, ip);
      if (ipBanned) {
        return sendError(res, "You are banned from creating new users", 403);
      }
    }

    // 2️⃣ Username availability — MongoDB (no Redis equivalent for all usernames)
    const existingUser = await userService.findUserByName(name);
    if (existingUser) {
      return sendError(res, "User name already taken!", 400);
    }

    // 3️⃣ Rate limit check: reject if this IP already registered within the window
    if (ip) {
      const existing = await redis.get(`${REG_RATE_LIMIT_PREFIX}${ip}`);
      if (existing !== null) {
        return sendError(res, "Account creation limit reached. Try again in 10 minutes.", 429);
      }
    }

    // 4️⃣ Create user — rate limit key set only after this succeeds
    await userService.createUser(name, ip);

    if (ip) {
      await redis.set(`${REG_RATE_LIMIT_PREFIX}${ip}`, "1", {
        NX: true,
        EX: REG_RATE_LIMIT_TTL,
      });
    }

    sendResponse(res, null, "User created successfully", 201);
  } catch (error) {
    console.log(error);
    sendError(res, "Internal server error", 500);
  }
}

async function updateUser(req, res) {
  const { name, isBanned } = req?.body;

  try {
    const user = await userService.findUserByName(name);
    if (!user) {
      return sendError(res, "User not found!", 404);
    }

    await userService.updateUser(name, { isBanned });

    if (isBanned === true) {
      if (user.ipAddress) {
        const bannedNames = await userService.banAllUsersByIp(user.ipAddress);
        if (bannedNames.length > 0) {
          const pipeline = redis.multi();
          pipeline.sAdd(BANNED_USERS_KEY, bannedNames);
          pipeline.sAdd(BANNED_IPS_KEY, user.ipAddress);
          await pipeline.exec();
          await broadcastBanToAllRooms(bannedNames);
        }
      } else {
        await redis.sAdd(BANNED_USERS_KEY, name);
      }
    } else {
      await redis.sRem(BANNED_USERS_KEY, name);
      // Do NOT remove from BANNED_IPS_KEY — other accounts on the same IP may
      // still be banned. IP removal requires an explicit IP-level ban action.
    }

    sendResponse(res, null, "User Data Updated Successfully", 200);
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}

async function getUserController(req, res) {
  const { name } = req?.body;
  try {
    // const user = await userService.findUserByName(name);
    // sendResponse(res, user, "User Data Retrieved Successfully", 200);
    const isBanned = !!(await redis.sIsMember(BANNED_USERS_KEY, name));
    sendResponse(res, { name, isBanned }, "User Data Retrieved Successfully", 200);
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}

async function isUserBannedController(req, res) {
  const { name } = req?.body;
  try {
    // BANNED_USERS_KEY is the source of truth — warm at startup, kept in sync
    // on every ban/unban. No MongoDB fallback needed.
    const isBanned = !!(await redis.sIsMember(BANNED_USERS_KEY, name));
    return sendResponse(
      res,
      { isBanned, userName: name },
      "User Data Retrieved Successfully",
      200,
    );
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}

module.exports = {
  updateUser,
  registerUserController,
  getUserController,
  isUserBannedController,
};
