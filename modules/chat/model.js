// models/ChatRoom.js
const mongoose = require("mongoose");

const chatRoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
    },
    // Remove messages array - they're in separate collection
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
