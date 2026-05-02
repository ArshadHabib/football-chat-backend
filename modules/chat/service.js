const mongoose = require("mongoose");
const ChatRoomModel = require("./model");
const MessageModel = require("./messageModel");
const {
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");
const {
  MAX_ROOM_MESSAGES_LIMIT,
  REDIS_ROOM_MSG_COUNTS,
  REDIS_ROOM_LAST_ACTIVITY,
  REDIS_ROOM_MSG_COUNTS_DRAIN,
  REDIS_ROOM_LAST_ACTIVITY_DRAIN,
  DRAIN_LOCK_KEY,
} = require("@project/utils/const_config");
const { pubClient: redis } = require("@project/config/redis");

// Drain lock TTL floor — only used here, behavior tuning not a Redis key.
const DRAIN_LOCK_TTL_FLOOR_MS = 10_000;

// Batch message saving
const messageBatch = new Map();

async function flushMessageBatch() {
  if (messageBatch.size === 0) return;

  const allMessages = [];
  const roomUpdates = [];

  messageBatch.forEach((messages, roomId) => {
    if (messages.length > 0) {
      allMessages.push(...messages);
      roomUpdates.push({ roomId, count: messages.length });
    }
  });

  try {
    if (allMessages.length > 0) {
      await MessageModel.insertMany(allMessages, { ordered: false });
    }

    // Counter writes go to Redis instead of MongoDB. The elected drainer
    // (drainRoomCountersLoop) periodically flushes the accumulated counts
    // to ChatRoomModel via a single bulkWrite — eliminating same-document
    // write contention across the 5 PM2 instances.
    if (roomUpdates.length > 0) {
      const pipeline = redis.multi();
      const now = Date.now().toString();
      for (const { roomId, count } of roomUpdates) {
        pipeline.hIncrBy(REDIS_ROOM_MSG_COUNTS, roomId, count);
        pipeline.hSet(REDIS_ROOM_LAST_ACTIVITY, roomId, now);
      }
      await pipeline.exec();
    }

    console.log(
      `Flushed ${allMessages.length} messages to ${roomUpdates.length} rooms`
    );
  } catch (error) {
    console.error("Batch flush error:", error);
  }

  messageBatch.clear();
}

// Self-rescheduling loop replaces setInterval. Re-reads batchFlush each cycle
// so live performance-mode changes (POST /change-server-mode) take effect on
// the next iteration instead of being locked in at module load.
async function flushMessageBatchLoop() {
  try {
    await flushMessageBatch();
  } catch (err) {
    console.error("Flush loop error:", err);
  } finally {
    const next = getCurrentPerformanceMode().settings.batchFlush;
    setTimeout(flushMessageBatchLoop, next);
  }
}
flushMessageBatchLoop();

// Drains Redis-accumulated room counters to MongoDB once per batchFlush window.
// Uses RENAME swap-key pattern: live accumulator atomically renamed into a drain
// key, bulkWrite to Mongo, then drain key is deleted only on success. Survives
// crashes — a half-drained snapshot stays in the swap key and the next elected
// instance resumes from it. No data loss, no double-counting.
async function drainRoomCounters() {
  const leftoverExists = await redis.exists(REDIS_ROOM_MSG_COUNTS_DRAIN);

  if (!leftoverExists) {
    try {
      await redis.rename(REDIS_ROOM_MSG_COUNTS, REDIS_ROOM_MSG_COUNTS_DRAIN);
    } catch {
      return; // source key absent — no pending counter data this cycle
    }
    if (await redis.exists(REDIS_ROOM_LAST_ACTIVITY)) {
      await redis.rename(
        REDIS_ROOM_LAST_ACTIVITY,
        REDIS_ROOM_LAST_ACTIVITY_DRAIN,
      );
    }
  }

  const [counts, activities] = await Promise.all([
    redis.hGetAll(REDIS_ROOM_MSG_COUNTS_DRAIN),
    redis.hGetAll(REDIS_ROOM_LAST_ACTIVITY_DRAIN),
  ]);

  const roomIds = Object.keys(counts || {});
  if (roomIds.length === 0) {
    await redis.del([
      REDIS_ROOM_MSG_COUNTS_DRAIN,
      REDIS_ROOM_LAST_ACTIVITY_DRAIN,
    ]);
    return;
  }

  const ops = roomIds.map((roomId) => ({
    updateOne: {
      filter: { roomId },
      update: {
        $inc: { messageCount: parseInt(counts[roomId]) || 0 },
        $set: {
          lastActivity: new Date(parseInt(activities[roomId]) || Date.now()),
        },
      },
      upsert: true,
    },
  }));

  try {
    await ChatRoomModel.bulkWrite(ops, { ordered: false });
    await redis.del([
      REDIS_ROOM_MSG_COUNTS_DRAIN,
      REDIS_ROOM_LAST_ACTIVITY_DRAIN,
    ]);
    console.log(`Drained counters for ${roomIds.length} rooms`);
  } catch (err) {
    console.error("Counter drain bulkWrite failed — will retry next cycle:", err);
    // Swap keys remain intact so the next election retries the same snapshot.
  }
}

// Mode-aware drainer loop. Only one instance per cycle wins the NX lock and
// runs drainRoomCounters; the other 4 return immediately. Re-reads batchFlush
// each iteration so admin mode changes take effect within one cycle.
async function drainRoomCountersLoop() {
  try {
    const interval = getCurrentPerformanceMode().settings.batchFlush;
    const lockTtl = Math.max(interval * 2, DRAIN_LOCK_TTL_FLOOR_MS);
    const won = await redis.set(DRAIN_LOCK_KEY, "1", {
      NX: true,
      PX: lockTtl,
    });

    if (won) {
      try {
        await drainRoomCounters();
      } finally {
        await redis.del(DRAIN_LOCK_KEY).catch(() => {});
      }
    }
  } catch (err) {
    console.error("Drain loop error:", err);
  } finally {
    const next = getCurrentPerformanceMode().settings.batchFlush;
    setTimeout(drainRoomCountersLoop, next);
  }
}
drainRoomCountersLoop();

// Reaction batch: Map<messageId, Map<emoji, Set<username>>>
const reactionBatch = new Map();
const dirtyMessageIds = new Set();
// Tracks how many flush cycles a messageId has been pending without a DB match.
// Prevents phantom entries from leaking memory if the message never appears.
const reactionRetries = new Map();
const MAX_REACTION_RETRIES = 10;

async function flushReactionBatch() {
  if (dirtyMessageIds.size === 0) return;
  const ids = Array.from(dirtyMessageIds);
  dirtyMessageIds.clear();

  for (const messageId of ids) {
    const reactions = reactionBatch.get(messageId);
    if (!reactions) continue;
    const setFields = {};
    const unsetFields = {};
    reactions.forEach((users, emoji) => {
      if (users.size > 0) {
        setFields[`reactions.${emoji}`] = Array.from(users);
      } else {
        unsetFields[`reactions.${emoji}`] = "";
      }
    });
    const update = {};
    if (Object.keys(setFields).length > 0) update.$set = setFields;
    if (Object.keys(unsetFields).length > 0) update.$unset = unsetFields;
    try {
      const result = await MessageModel.updateOne({ _id: messageId }, update);
      if (result.matchedCount === 0) {
        // Message not in DB yet — may still be in another instance's write batch.
        // Retry up to MAX_REACTION_RETRIES cycles, then give up.
        const retries = (reactionRetries.get(messageId) || 0) + 1;
        if (retries >= MAX_REACTION_RETRIES) {
          reactionBatch.delete(messageId);
          reactionRetries.delete(messageId);
        } else {
          reactionRetries.set(messageId, retries);
          dirtyMessageIds.add(messageId);
        }
      } else {
        reactionRetries.delete(messageId);
        // Evict from cache only if no new reaction arrived during the flush window
        if (!dirtyMessageIds.has(messageId)) {
          reactionBatch.delete(messageId);
        }
      }
    } catch (err) {
      // Re-add to dirty set so the next flush retries this messageId
      dirtyMessageIds.add(messageId);
      console.error("Reaction flush error:", err);
    }
  }
}

setInterval(flushReactionBatch, getCurrentPerformanceMode().settings.batchFlush);

// Returns serialized reactions object after applying toggle/switch logic.
// Loads from DB into batch on first access for a given messageId.
async function applyReactionService(messageId, emoji, username) {
  if (!reactionBatch.has(messageId)) {
    const msg = await MessageModel.findById(messageId).select("reactions").lean();
    if (msg) {
      const reactionMap = new Map();
      if (msg.reactions) {
        for (const [e, users] of Object.entries(msg.reactions)) {
          reactionMap.set(e, new Set(users));
        }
      }
      reactionBatch.set(messageId, reactionMap);
    } else {
      // Message not in DB yet (still in a write batch on some instance).
      // Seed an empty reaction map so the reaction is applied in memory now.
      // flushReactionBatch will retry writing reactions to DB until the message
      // appears — works across all PM2 instances since MongoDB is shared.
      if (!mongoose.isValidObjectId(messageId)) return null;
      reactionBatch.set(messageId, new Map());
    }
  }

  const reactions = reactionBatch.get(messageId);

  // Remove user from any existing emoji (one reaction per user per message)
  let previousEmoji = null;
  reactions.forEach((users, e) => {
    if (users.has(username)) {
      previousEmoji = e;
      users.delete(username);
    }
  });

  // Toggle off if same emoji; otherwise add the new one
  if (previousEmoji !== emoji) {
    if (!reactions.has(emoji)) reactions.set(emoji, new Set());
    reactions.get(emoji).add(username);
  }

  dirtyMessageIds.add(messageId);

  const serialized = {};
  reactions.forEach((users, e) => {
    if (users.size > 0) serialized[e] = Array.from(users);
  });
  return serialized;
}

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
  applyReactionService,
  retrieveRoomMessagesService,
  deleteAllChatMessagesService,
  deleteAllDBChatRoomService,
  getRoomStats,
};
