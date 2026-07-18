const express = require("express");
const router = express.Router();
const { isAdmin, isUserLoggedIn } = require("@project/middleware");
const {
  getModerationLogsController,
  getModerationStatsController,
  setUserBanController,
} = require("./controller");

// Admin JWT auth (same as /get-users-per-room in the chat router) — these
// endpoints are called by the football-admin panel with the bearer token.
router.get(
  "/get-moderation-logs",
  isUserLoggedIn,
  isAdmin,
  getModerationLogsController,
);
router.get(
  "/get-moderation-stats",
  isUserLoggedIn,
  isAdmin,
  getModerationStatsController,
);
router.post("/set-user-ban", isUserLoggedIn, isAdmin, setUserBanController);

module.exports = router;
