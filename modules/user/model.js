// @ts-nocheck
const mongoose = require("mongoose");
const { ROLES } = require("@project/utils");

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
      minlength: [2, "Name must be at least 2 characters long"],
      maxlength: [50, "Name must be at most 50 characters long"],
      unique: true,
    },
    isBanned: {
      type: Boolean,
      required: false,
      default: false,
    },
    ipAddress: {
      type: String,
      required: false,
      index: true,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatUsers", userSchema);
