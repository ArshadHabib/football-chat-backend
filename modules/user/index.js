const express = require("express");
const router = express.Router();
const authController = require("./controller");
const {
  isAdmin,
  isUserLoggedIn,
  attachClientIp,
} = require("@project/middleware");

// User routes
router.post(
  "/register-user",
  // attachClientIp,
  authController.registerUserController
);
router.patch(
  "/update-user",
  isUserLoggedIn,
  isAdmin,
  authController.updateUser
);
router.post(
  "/get-user",
  isUserLoggedIn,
  isAdmin,
  authController.getUserController
);
router.post("/is-user-banned", authController.isUserBannedController);

module.exports = router;
