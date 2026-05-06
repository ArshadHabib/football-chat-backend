const {
  getUsersPerRoom,
  deleteAllRooms,
  deleteRoom,
  createRoom,
  updateViewsVisibility,
} = require("@project/socket/roomManager");
const {
  createChatRoomService,
  deleteChatRoomService,
  retrieveRoomMessagesService,
  deleteAllDBChatRoomService,
} = require("./service");
const { sendResponse, sendError } = require("@project/utils");
const { createSocketRoomsForMatchService } = require("./socket_service");
const { sendLatestMatches } = require("@project/socket/adminEventService");
const {
  setPerformanceMode,
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");
const { pubClient } = require("@project/config/redis");

async function getUsersPerRoomController(req, res) {
  try {
    const usersPerRoom = await getUsersPerRoom();
    return sendResponse(
      res,
      usersPerRoom,
      "Users per room retrieved successfully!",
      200
    );
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error retrieving users per room",
      500
    );
  }
}

async function getRoomMessagesController(req, res) {
  try {
    const { roomId, noLimit } = req.query;
    const messages = await retrieveRoomMessagesService(roomId, noLimit);
    // Allow nginx/browser to cache the response for 5s during burst traffic.
    // Admin requests (noLimit=true) always bypass Redis and hit MongoDB fresh,
    // so we only set the cache header for the standard user path.
    if (!noLimit) {
      res.set("Cache-Control", "public, max-age=5");
    }
    return sendResponse(
      res,
      messages,
      "Room messages retrieved successfully!",
      200
    );
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error retrieving room messages",
      500
    );
  }
}

async function deleteAllSocketRoomsController(req, res) {
  const { matches } = req.body;
  try {
    await deleteAllDBChatRoomService();
    await deleteAllRooms();
    if (matches.length) {
      await createSocketRoomsForMatchService(matches);
    }
    return sendResponse(res, null, "Socket Rooms deleted successfully!", 200);
  } catch (error) {
    return sendError(res, error?.message || "Error deleting socket rooms", 500);
  }
}

async function deleteSingleSocketRoomController(req, res) {
  const { roomId } = req.body;
  try {
    await deleteRoom(roomId);
    return sendResponse(res, null, "Socket Room deleted successfully!", 200);
  } catch (error) {
    return sendError(res, error?.message || "Error deleting socket room", 500);
  }
}

async function createSingleSocketRoomController(req, res) {
  const { roomId, showViews } = req.body;
  try {
    await createRoom(roomId, showViews);
    return sendResponse(res, null, "Socket Room created successfully!", 200);
  } catch (error) {
    return sendError(res, error?.message || "Error creating socket room", 500);
  }
}

async function sendLatestUpdatesToAdminController(req, res) {
  const { matches, lastUpdatedAdminId } = req.body;
  try {
    sendLatestMatches(matches, lastUpdatedAdminId);
    return sendResponse(
      res,
      null,
      "Latest Matches sent to Admin successfully!",
      200
    );
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error in sending latest matches to admin: ",
      500
    );
  }
}

async function updateShowViewsVisibilityToUsersController(req, res) {
  const { streamId, showViews } = req.body;
  try {
    await updateViewsVisibility({ roomId: streamId, data: { showViews } });
    return sendResponse(res, null, "Success in sending Views Visibility!", 200);
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error in sending Views Visibility: ",
      500
    );
  }
}

async function changeServerModeController(req, res) {
  const { mode } = req.body;
  try {
    setPerformanceMode(mode);
    // Broadcast to all other processes so they update their mode too
    await pubClient.publish("__perf_mode__", mode);
    return sendResponse(
      res,
      null,
      "Success in changing performance mode!",
      200
    );
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error in changing performance mode: ",
      500
    );
  }
}

async function getServerModeController(req, res) {
  try {
    const result = await getCurrentPerformanceMode();
    return sendResponse(
      res,
      result,
      "Success in getting performance mode!",
      200
    );
  } catch (error) {
    return sendError(
      res,
      error?.message || "Error in getting performance mode: ",
      500
    );
  }
}

module.exports = {
  getUsersPerRoomController,
  getRoomMessagesController,
  deleteAllSocketRoomsController,
  deleteSingleSocketRoomController,
  createSingleSocketRoomController,
  sendLatestUpdatesToAdminController,
  updateShowViewsVisibilityToUsersController,
  changeServerModeController,
  getServerModeController,
};
