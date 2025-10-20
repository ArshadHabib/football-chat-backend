const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  senderName: {
    type: String,
    required: false,
    default: "Anonymous",
  },
  senderId: {
    type: String,
    required: false,
  },
  messageContent: {
    type: String,
    required: false,
    default: "",
  },
  messageType: {
    type: String,
    required: false,
    default: "room_message",
  },
  isPinned: {
    type: Boolean,
    required: false,
    default: false,
  },
  isAdmin: {
    type: Boolean,
    required: false,
    default: false,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

const chatRoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
    },
    messages: {
      type: [messageSchema],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
