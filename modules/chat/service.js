const mongoose = require("mongoose");
const ChatRoomModel = require("./model");
const MessageModel = require("./messageModel");
const {
  BATCH_FLUSH_INTERVAL,
  MAX_BATCH_SIZE,
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");
const { MAX_ROOM_MESSAGES_LIMIT } = require("@project/utils/const_config");

// Batch message saving
const messageBatch = new Map();

async function flushMessageBatch() {
  if (messageBatch.size === 0) return;

  const allMessages = [];
  const roomUpdates = [];

  // Collect data
  messageBatch.forEach((messages, roomId) => {
    if (messages.length > 0) {
      allMessages.push(...messages);
      roomUpdates.push({ roomId, count: messages.length });
    }
  });

  try {
    // Insert all messages
    if (allMessages.length > 0) {
      await MessageModel.insertMany(allMessages, { ordered: false });
    }

    // Update rooms
    for (const { roomId, count } of roomUpdates) {
      await ChatRoomModel.findOneAndUpdate(
        { roomId },
        {
          lastActivity: new Date(),
          $inc: { messageCount: count },
        },
        { upsert: true }
      );
    }

    console.log(
      `Flushed ${allMessages.length} messages to ${roomUpdates.length} rooms`
    );
  } catch (error) {
    console.error("Batch flush error:", error);
  }

  messageBatch.clear();
}

setInterval(flushMessageBatch, getCurrentPerformanceMode().settings.batchFlush);

async function saveChatMessageService(roomId, messageData) {
  const message = {
    _id: new mongoose.Types.ObjectId(),
    roomId,
    ...messageData,
    timestamp: new Date(),
  };

  if (!messageBatch.has(roomId)) {
    messageBatch.set(roomId, []);
  }

  const batch = messageBatch.get(roomId);
  batch.push(message);

  if (batch.length >= getCurrentPerformanceMode().settings.maxBatchSize) {
    await flushMessageBatch();
  }

  return true;
}

async function createChatRoomService(roomId) {
  try {
    // Use upsert to create if doesn't exist, or update if exists
    const result = await ChatRoomModel.findOneAndUpdate(
      { roomId },
      {
        $setOnInsert: { roomId },
        $set: { lastActivity: new Date() },
        // Don't reset messageCount if room already exists
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    console.log(
      `Chat room created/verified successfully with roomId: ${roomId}`
    );
    return true;
  } catch (error) {
    console.error(`Error creating chat room ${roomId}:`, error.message);
    return false;
  }
}

async function deleteChatRoomService(roomId) {
  try {
    const deletedRoom = await ChatRoomModel.findOneAndDelete({ roomId });
    if (!deletedRoom) {
      console.error(`DB Chat room with roomId '${roomId}' not found`);
      return null;
    }
    console.log(`DB Chat room deleted successfully with roomId: ${roomId}`);
    return true;
  } catch (error) {
    return null;
  }
}

async function deleteAllDBChatRoomService() {
  try {
    // Delete all rooms and all messages in parallel
    const [roomResult, messageResult] = await Promise.all([
      ChatRoomModel.deleteMany({}),
      MessageModel.deleteMany({}),
    ]);

    if (roomResult.deletedCount === 0 && messageResult.deletedCount === 0) {
      console.log("No chat rooms or messages found to delete");
      return {
        success: true,
        message: "No data to delete",
        roomsDeleted: 0,
        messagesDeleted: 0,
      };
    }

    console.log(
      `All chat rooms and messages deleted successfully. Rooms: ${roomResult.deletedCount}, Messages: ${messageResult.deletedCount}`
    );
    return true;
  } catch (error) {
    console.error("Error deleting all chat rooms and messages:", error.message);
    return false;
  }
}

async function retrieveRoomMessagesService(roomId, noLimit, options = {}) {
  try {
    const {
      limit = 200,
      skip = 0,
      before = new Date(), // For pagination
    } = options;
    let messages = [];
    let pinnedMessage = null;

    if (noLimit) {
      messages = await MessageModel.find({
        roomId,
      })
        .sort({ timestamp: -1 })
        .limit(MAX_ROOM_MESSAGES_LIMIT)
        .lean();
    } else {
      messages = await MessageModel.find({
        roomId,
        timestamp: { $lt: before },
      })
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(skip)
        .lean();
      pinnedMessage = await MessageModel.find({
        roomId,
        isPinned: true,
      })
        .sort({ timestamp: -1 })
        .limit(1)
        .lean();
    }

    console.log(`Retrieved ${messages?.length} messages from room: ${roomId}`);
    return {
      messages: messages?.reverse(),
      pinnedMessage: pinnedMessage ? pinnedMessage[0] : null,
    };
  } catch (error) {
    console.error(
      `Error retrieving messages from room ${roomId}:`,
      error.message
    );
    return [];
  }
}

async function deleteAllChatMessagesService() {
  try {
    // Delete all messages from Message collection
    const messageResult = await MessageModel.deleteMany({});

    // Reset all chat rooms (messageCount = 0, lastActivity = now)
    const roomResult = await ChatRoomModel.updateMany(
      {},
      {
        $set: {
          messageCount: 0,
          lastActivity: new Date(),
        },
      }
    );

    console.log(
      `All chat messages deleted successfully. Messages: ${messageResult.deletedCount}, Rooms reset: ${roomResult.modifiedCount}`
    );
    return true;
  } catch (error) {
    console.error("Error deleting all chat messages:", error.message);
    return false;
  }
}

// Get room stats
async function getRoomStats(roomId) {
  const [messageCount, lastActivity] = await Promise.all([
    MessageModel.countDocuments({ roomId }),
    MessageModel.findOne({ roomId })
      .sort({ timestamp: -1 })
      .select("timestamp"),
  ]);

  return {
    messageCount,
    lastActivity: lastActivity?.timestamp || null,
  };
}

// Single room deletion (if needed elsewhere)
async function deleteChatRoomService(roomId) {
  try {
    // Delete room and its messages in parallel
    const [roomResult, messageResult] = await Promise.all([
      ChatRoomModel.deleteOne({ roomId }),
      MessageModel.deleteMany({ roomId }),
    ]);

    console.log(
      `Chat room and messages deleted: ${roomId}. Messages: ${messageResult.deletedCount}`
    );
    return true;
  } catch (error) {
    console.error(`Error deleting chat room ${roomId}:`, error.message);
    return false;
  }
}

module.exports = {
  createChatRoomService,
  deleteChatRoomService,
  saveChatMessageService,
  retrieveRoomMessagesService,
  deleteAllChatMessagesService,
  deleteAllDBChatRoomService,
  getRoomStats,
};
