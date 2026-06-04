// models/Message.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      index: true, // Critical for performance
    },
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
    reactions: {
      type: Map,
      of: [String],
      default: {},
    },
    adminReactions: {
      type: Map,
      of: Number,
      default: {},
    },
    replyTo: {
      type: {
        messageId: { type: String, required: true },
        senderName: { type: String, required: true, maxlength: 50 },
        contentSnippet: { type: String, required: true, maxlength: 140 },
        isAdmin: { type: Boolean, default: false },
      },
      required: false,
      default: undefined,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true, // For sorting
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for fast room queries
messageSchema.index({ roomId: 1, timestamp: -1 });
messageSchema.index({ roomId: 1, isPinned: 1 });

module.exports = mongoose.model("Message", messageSchema);
