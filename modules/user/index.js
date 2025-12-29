const express = require("express");
const router = express.Router();
const authController = require("./controller");
const { isAdmin, isUserLoggedIn } = require("@project/middleware");

// User routes
router.post("/register-user", authController.registerUserController);
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

module.exports = router;
