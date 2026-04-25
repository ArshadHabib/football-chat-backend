// socket/roomManager.js
const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");
const {
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");
const { pubClient: redis } = require("@project/config/redis");

// === LOCAL SOCKET TRACKING (per-process, for socket.join/leave mechanics) ===
const rooms = new Map(); // roomId -> Set of local socketIds
const adminSockets = new Set(); // local admin socket objects (for removeAdmin/isAdmin)
const roomUserCountUpdates = new Map();
const socketWebsite = new Map(); // socketId -> websiteName (local cache)

// Redis keys
const REDIS_ROOMS_SET = "__rooms__";
const REDIS_ROOM_COUNTS = "__room_counts__";
const REDIS_SOCKET_WEBSITE = "__socket_website__";

// Cache and debouncing
let cachedRoomData = null;
let adminUpdateTimeout = null;
let userCountUpdateTimeout = null;

// === DERIVED COUNTERS — all read from Redis (cross-process truth) ===

async function getTotalUsers() {
  const counts = await redis.hGetAll(REDIS_ROOM_COUNTS);
  return Object.values(counts).reduce((sum, v) => sum + (parseInt(v) || 0), 0);
}

async function getUsersPerRoom() {
  const counts = await redis.hGetAll(REDIS_ROOM_COUNTS);
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, parseInt(v) || 0]),
  );
}

async function getUsersPerWebsite() {
  const websiteMap = await redis.hGetAll(REDIS_SOCKET_WEBSITE);
  const counts = {};
  Object.values(websiteMap).forEach((site) => {
    if (site) counts[site] = (counts[site] || 0) + 1;
  });
  return counts;
}

function getRoomUserCount(roomId) {
  const socketIds = rooms.get(roomId);
  return socketIds ? socketIds.size : 0;
}

async function createRoom(roomId) {
  const alreadyInRedis = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (alreadyInRedis) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  await redis.sAdd(REDIS_ROOMS_SET, roomId);
  await redis.hSet(REDIS_ROOM_COUNTS, roomId, "0");

  console.log(`Room created: ${roomId}`);

  createChatRoomService(roomId);
  invalidateCache();
  scheduleAdminRoomUpdate();
  return { success: true, roomId };
}

async function deleteRoom(roomId) {
  const existsInRedis = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (!existsInRedis) {
    return { success: false, message: "Room does not exist" };
  }

  const io = getIO();

  // Fetch ALL socket IDs in this room across all processes via the Redis adapter
  // then clean up their website tracking entries in one pipeline
  const allSocketIds = io ? await io.in(roomId).allSockets() : new Set();
  const pipeline = redis.multi();
  allSocketIds.forEach((socketId) => {
    socketWebsite.delete(socketId); // clean local cache too
    pipeline.hDel(REDIS_SOCKET_WEBSITE, socketId);
  });
  await pipeline.exec();

  if (io) {
    io.to(roomId).emit("room_deleted", { roomId });
  }

  rooms.delete(roomId);
  await redis.sRem(REDIS_ROOMS_SET, roomId);
  await redis.hDel(REDIS_ROOM_COUNTS, roomId);

  deleteChatRoomService(roomId);

  invalidateCache();
  scheduleAdminRoomUpdate();
  roomUserCountUpdates.delete(roomId);
  return { success: true, roomId };
}

async function deleteAllRooms() {
  const roomIds = await redis.sMembers(REDIS_ROOMS_SET);

  // Always clear stale socket data regardless of room count.
  // On server restart, __rooms__ may be empty but __socket_website__ still holds
  // stale entries from sockets that disconnected without triggering leaveRoom().
  rooms.clear();
  socketWebsite.clear();
  await Promise.all([
    redis.del(REDIS_ROOMS_SET),
    redis.del(REDIS_ROOM_COUNTS),
    redis.del(REDIS_SOCKET_WEBSITE),
  ]);

  if (roomIds.length === 0) {
    console.log("No Socket Rooms to Delete!");
    return { success: true, message: "No rooms to delete", deletedCount: 0 };
  }

  const deletedCount = roomIds.length;

  const io = getIO();
  roomIds.forEach((roomId) => {
    if (io) {
      io.to(roomId).emit("room_deleted", { roomId });
    }
    deleteChatRoomService(roomId);
  });

  console.log(`All ${deletedCount} rooms deleted`);
  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    success: true,
    message: `All ${deletedCount} rooms deleted successfully`,
    deletedCount,
    deletedRooms: roomIds,
  };
}

async function joinRoom(roomId, socket, senderName, websiteName) {
  const existsInRedis = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (!existsInRedis) {
    return { success: false, message: "Room does not exist" };
  }

  // Warm local cache if this process didn't create the room
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const socketIds = rooms.get(roomId);
  const isNewJoin = !socketIds.has(socket.id);
  socketIds.add(socket.id);

  // Store room ID for this socket
  socket.roomId = roomId;

  // Store website name locally and in Redis
  if (websiteName) {
    socketWebsite.set(socket.id, websiteName);
    await redis.hSet(REDIS_SOCKET_WEBSITE, socket.id, websiteName);
  }

  socket.join(roomId);

  let count;
  if (isNewJoin) {
    count = await redis.hIncrBy(REDIS_ROOM_COUNTS, roomId, 1);
  } else {
    count = parseInt(await redis.hGet(REDIS_ROOM_COUNTS, roomId)) || 0;
  }

  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    success: true,
    roomId,
    usersCount: count,
  };
}

async function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId) return null;

  // Clean up local state
  if (rooms.has(roomId)) {
    const socketIds = rooms.get(roomId);
    socketIds.delete(socket.id);
  }

  // Clean up website data locally and in Redis
  socketWebsite.delete(socket.id);
  await redis.hDel(REDIS_SOCKET_WEBSITE, socket.id);

  socket.leave(roomId);
  socket.roomId = null;

  // Decrement Redis counter only if room still exists
  const roomStillExists = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  let count = 0;
  if (roomStillExists) {
    count = await redis.hIncrBy(REDIS_ROOM_COUNTS, roomId, -1);
    if (count < 0) {
      await redis.hSet(REDIS_ROOM_COUNTS, roomId, "0");
      count = 0;
    }
  }

  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    roomId,
    usersCount: count,
  };
}

function getUsersInRoom(roomId) {
  // Since we don't store senderNames, return count only
  return [];
}

async function roomExists(roomId) {
  const exists = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (!exists && rooms.has(roomId)) {
    rooms.delete(roomId); // clean up stale local cache entry
  }
  return exists;
}

function updateViewsVisibility(data) {
  const io = getIO();
  if (io) {
    io.to(data?.roomId).emit("update_views_visibility", data?.data);
  }
}

// Admin management
async function registerAdmin(socket) {
  adminSockets.add(socket);
  socket.join("__admins__"); // works cross-process via Redis adapter
  console.log("Admin registered:", socket.id);

  // Send cached data immediately
  const roomData = await getCachedRoomData();
  socket.emit("admin_room_update", roomData);
}

function removeAdmin(socket) {
  adminSockets.delete(socket);
  // socket.leave("__admins__") is handled automatically by Socket.io on disconnect
}

function scheduleAdminRoomUpdate() {
  if (adminUpdateTimeout) {
    clearTimeout(adminUpdateTimeout);
  }

  // Always fire immediately regardless of performance mode — admins get real-time updates
  adminUpdateTimeout = setTimeout(async () => {
    await notifyAdminRoomUpdate();
  }, 0);
}

async function notifyAdminRoomUpdate() {
  const io = getIO();
  if (!io) return;

  const roomData = await getCachedRoomData();
  // io.to("__admins__") reaches ALL admin sockets across all 6 processes via Redis adapter
  io.to("__admins__").emit("admin_room_update", roomData);

  console.log(`Admin room update sent to __admins__ room`);
}

// Smart caching
async function getCachedRoomData() {
  const now = Date.now();

  if (
    cachedRoomData &&
    now - cachedRoomData.cacheTime <
      getCurrentPerformanceMode().settings.cacheTTL
  ) {
    return cachedRoomData;
  }

  const [usersPerRoom, usersPerWebsite] = await Promise.all([
    getUsersPerRoom(),
    getUsersPerWebsite(),
  ]);

  const totalUsers = Object.values(usersPerRoom).reduce((sum, v) => sum + v, 0);

  cachedRoomData = {
    usersPerRoom,
    usersPerWebsite,
    totalUsers,
    totalRooms: Object.keys(usersPerRoom).length,
    timestamp: new Date().toISOString(),
    cacheTime: now,
  };

  return cachedRoomData;
}

function invalidateCache() {
  cachedRoomData = null;
}

function isAdmin(socket) {
  return adminSockets.has(socket);
}

function emitToAdmins(eventName, data) {
  const io = getIO();
  if (!io) return 0;

  const eventData = {
    ...data,
    timestamp: new Date().toISOString(),
    eventType: eventName,
  };

  // io.to("__admins__") reaches ALL admin sockets across all 6 processes via Redis adapter
  io.to("__admins__").emit("admin_custom_event", eventData);

  return 1; // dispatched (exact count across cluster is unknown, callers only check > 0)
}

function emitToAdmin(socketId, eventName, data) {
  const io = getIO();
  if (!io) return false;

  // io.to(socketId) works cross-process with Redis adapter
  io.to(socketId).emit("admin_custom_event", {
    ...data,
    timestamp: new Date().toISOString(),
    eventType: eventName,
  });

  return true;
}

function scheduleUserCountUpdate(roomId, usersCount) {
  // Store the latest count for this room
  roomUserCountUpdates.set(roomId, usersCount);

  // Debounce updates
  if (userCountUpdateTimeout) {
    clearTimeout(userCountUpdateTimeout);
  }

  userCountUpdateTimeout = setTimeout(async () => {
    await broadcastUserCountUpdates();
  }, getCurrentPerformanceMode().settings.userCountUpdateDebounce);
}

async function broadcastUserCountUpdates() {
  const io = getIO();
  if (!io) return;

  for (const [roomId, usersCount] of roomUserCountUpdates) {
    // Only broadcast if room still exists — always check Redis as source of truth
    const exists = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
    if (!exists) rooms.delete(roomId); // clean up stale local entry if room is gone
    if (exists) {
      io.to(roomId).emit("room_user_count_update", {
        roomId,
        usersCount,
      });
    }
  }

  roomUserCountUpdates.clear();
}

async function broadcastBanToAllRooms(userNames) {
  const io = getIO();
  if (!io || userNames.length === 0) return;

  const timestamp = new Date().toISOString();

  for (const name of userNames) {
    io.emit("user_updated", {
      name,
      isBanned: true,
      updatedBy: "admin",
      timestamp,
      eventType: "user_updated",
    });
  }
}

// Utility functions
let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function getIO() {
  return ioInstance;
}

// Validation function to ensure counts are always correct.
// Reconciles both __socket_website__ AND __room_counts__ against the live
// socket state across all instances. Catches stale entries left by crashed
// or restarted PM2 processes that didn't run leaveRoom on disconnect.
async function validateCounts(incomingObject = {}) {
  const { deleteStaleSockets } = incomingObject || {};
  if (deleteStaleSockets) {
    const io = getIO();

    if (io) {
      // Step 1: Reconcile __socket_website__ against live sockets
      // io.allSockets() works cross-process via the Redis adapter — returns
      // every socket ID connected to any of the 5 instances right now.
      const [liveSocketIds, websiteEntries] = await Promise.all([
        io.allSockets(),
        redis.hGetAll(REDIS_SOCKET_WEBSITE),
      ]);

      const staleSocketIds = Object.keys(websiteEntries).filter(
        (socketId) => !liveSocketIds.has(socketId),
      );

      if (staleSocketIds.length > 0) {
        const pipeline = redis.multi();
        staleSocketIds.forEach((socketId) => {
          socketWebsite.delete(socketId);
          pipeline.hDel(REDIS_SOCKET_WEBSITE, socketId);
        });
        await pipeline.exec();
        console.log(
          `🧹 Cleaned ${staleSocketIds.length} stale __socket_website__ entries`,
        );
      }

      // Step 2: Reconcile __room_counts__ against actual live socket counts per room.
      // For each room, the source of truth is io.in(roomId).allSockets().size
      // (cross-process). If __room_counts__ disagrees, it's stale from a crash.
      const roomIds = await redis.sMembers(REDIS_ROOMS_SET);
      const storedCounts = await redis.hGetAll(REDIS_ROOM_COUNTS);

      let fixedRooms = 0;
      for (const roomId of roomIds) {
        const actualSockets = await io.in(roomId).allSockets();
        const actualCount = actualSockets.size;
        const storedCount = parseInt(storedCounts[roomId]) || 0;

        if (actualCount !== storedCount) {
          await redis.hSet(REDIS_ROOM_COUNTS, roomId, actualCount.toString());
          fixedRooms++;
        }
      }

      if (fixedRooms > 0) {
        console.log(`🧹 Reconciled ${fixedRooms} room counts to actual values`);
        invalidateCache();
        scheduleAdminRoomUpdate();
      }
    }
  }

  // Step 3: Log count consistency
  const usersPerRoom = await getUsersPerRoom();
  const calculatedTotal = Object.values(usersPerRoom).reduce(
    (sum, count) => sum + count,
    0,
  );

  const usersPerWebsite = await getUsersPerWebsite();
  const websiteSum = Object.values(usersPerWebsite).reduce(
    (sum, count) => sum + count,
    0,
  );

  const roomSum = Object.values(usersPerRoom).reduce(
    (sum, count) => sum + count,
    0,
  );
  console.log(`🔍 COUNT VALIDATION:`);
  console.log(`   totalUsers: ${calculatedTotal}`);
  console.log(`   Sum of rooms: ${roomSum}`);
  console.log(`   Sum of websites: ${websiteSum}`);

  if (calculatedTotal !== websiteSum) {
    console.log(`🚨 CRITICAL: Count mismatch detected!`);
  } else {
    console.log(`✅ All counts are consistent`);
  }
}

// Run validation every 2 minutes — commented out for now, startup sweep in
// server.js handles the common case (instance crash/restart). Uncomment to
// re-enable as a safety net for mid-session drift.
setInterval(async () => {
  await validateCounts();
}, 120000);

module.exports = {
  createRoom,
  deleteRoom,
  joinRoom,
  leaveRoom,
  getUsersInRoom,
  roomExists,
  getTotalUsers,
  getUsersPerRoom,
  registerAdmin,
  removeAdmin,
  notifyAdminRoomUpdate,
  isAdmin,
  emitToAdmins,
  emitToAdmin,
  deleteAllRooms,
  getUsersPerWebsite,
  updateViewsVisibility,
  setIO,
  scheduleUserCountUpdate,
  validateCounts,
  broadcastBanToAllRooms,
};
