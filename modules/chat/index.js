const express = require("express");
const router = express.Router();
const {
  isAdmin,
  isUserLoggedIn,
  isAdminKeyCorrect,
} = require("@project/middleware");
const {
  getUsersPerRoomController,
  getRoomMessagesController,
  deleteAllSocketRoomsController,
  deleteSingleSocketRoomController,
  createSingleSocketRoomController,
  sendLatestUpdatesToAdminController,
  updateShowViewsVisibilityToUsersController,
  changeServerModeController,
  getServerModeController,
} = require("./controller");

router.get(
  "/get-users-per-room",
  isUserLoggedIn,
  isAdmin,
  getUsersPerRoomController
);

router.get("/get-room-messages", getRoomMessagesController);
router.post(
  "/delete-all-socket-rooms",
  isAdminKeyCorrect,
  deleteAllSocketRoomsController
);
router.post(
  "/delete-single-socket-room",
  isAdminKeyCorrect,
  deleteSingleSocketRoomController
);
router.post(
  "/create-single-socket-room",
  isAdminKeyCorrect,
  createSingleSocketRoomController
);
router.post(
  "/send-latest-matches-to-admin",
  isAdminKeyCorrect,
  sendLatestUpdatesToAdminController
);
router.post(
  "/update-show-views-visibility-to-users",
  isAdminKeyCorrect,
  updateShowViewsVisibilityToUsersController
);
router.post(
  "/change-server-mode",
  isAdminKeyCorrect,
  changeServerModeController
);
router.post("/get-server-mode", isAdminKeyCorrect, getServerModeController);

module.exports = router;
