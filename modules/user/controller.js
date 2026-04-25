const userService = require("./service");
const { sendResponse, sendError, generateToken } = require("@project/utils");
const { broadcastBanToAllRooms } = require("@project/socket/roomManager");

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
      await broadcastBanToAllRooms(bannedNames);
      return sendResponse(res, null, "Users Banned Successfully", 200);
    }

    const user = await userService.findUserByName(name);
    if (!user) {
      return sendError(res, "User not found!", 404);
    }

    await userService.updateUser(name, { isBanned });
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
