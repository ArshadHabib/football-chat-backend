const userService = require("./service");
const { sendResponse, sendError, generateToken } = require("@project/utils");
const { broadcastBanToAllRooms } = require("@project/socket/roomManager");
const { pubClient: redis } = require("@project/config/redis");
const { REG_RATE_LIMIT_PREFIX, REG_RATE_LIMIT_TTL, BANNED_USERS_KEY } = require("@project/utils/const_config");

async function registerUserController(req, res) {
  const { name, clientIp, inComingClientIp } = req?.body;
  try {
    // 1️⃣ Block banned IP immediately
    const bannedIpUser = await userService.findBannedUserByIp(
      inComingClientIp || clientIp
    );
    if (bannedIpUser) {
      return sendError(res, "You are banned from creating new users", 403);
    }

    // 2️⃣ Check username availability
    const existingUser = await userService.findUserByName(name);
    if (existingUser) {
      return sendError(res, "User name already taken!", 400);
    }

    // 3️⃣ Rate limit: 1 account per IP per 10 minutes (only on successful creation)
    const ip = inComingClientIp || clientIp;
    if (ip) {
      const set = await redis.set(`${REG_RATE_LIMIT_PREFIX}${ip}`, "1", {
        NX: true,
        EX: REG_RATE_LIMIT_TTL,
      });
      if (set === null) {
        return sendError(res, "Account creation limit reached. Try again in 10 minutes.", 429);
      }
    }

    await userService.createUser(name, inComingClientIp || clientIp);

    sendResponse(res, null, "User created successfully", 201);
  } catch (error) {
    console.log(error);
    sendError(res, "Internal server error", 500);
  }
}

async function updateUser(req, res) {
  const { name, ipAddress, isBanned } = req?.body;

  try {
    if (ipAddress && isBanned === true) {
      const bannedNames = await userService.banAllUsersByIp(ipAddress);
      if (bannedNames.length > 0) {
        await redis.sAdd(BANNED_USERS_KEY, bannedNames);
        await broadcastBanToAllRooms(bannedNames);
      }
      return sendResponse(res, null, "Users Banned Successfully", 200);
    }

    const user = await userService.findUserByName(name);
    if (!user) {
      return sendError(res, "User not found!", 404);
    }

    await userService.updateUser(name, { isBanned });

    if (isBanned === true) {
      await redis.sAdd(BANNED_USERS_KEY, name);
    } else {
      await redis.sRem(BANNED_USERS_KEY, name);
    }

    sendResponse(res, null, "User Data Updated Successfully", 200);
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}

async function getUserController(req, res) {
  const { name } = req?.body;
  try {
    const user = await userService.findUserByName(name);
    sendResponse(res, user, "User Data Retrieved Successfully", 200);
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}

async function isUserBannedController(req, res) {
  const { name } = req?.body;
  try {
    const user = await userService.findUserByName(name);
    sendResponse(
      res,
      { isBanned: user.isBanned, userName: user.name },
      "User Data Retrieved Successfully",
      200
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
