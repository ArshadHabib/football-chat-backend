// socket/roomManager.js
const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");
const {
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");

// === SINGLE SOURCE OF TRUTH ===
const rooms = new Map(); // roomId -> Set of socketIds (THIS IS THE TRUTH)
const adminSockets = new Set();
const roomUserCountUpdates = new Map();
const socketWebsite = new Map(); // socketId -> websiteName

// === REMOVED: All manual counters ===
// ❌ DELETED: const roomCounts = new Map();
// ❌ DELETED: const websiteCounts = new Map();
// ❌ DELETED: let totalUsers = 0;

// Cache and debouncing
let cachedRoomData = null;
let adminUpdateTimeout = null;
let userCountUpdateTimeout = null;

// === DERIVED COUNTERS (Computed from rooms Map) ===
function getTotalUsers() {
  let total = 0;
  rooms.forEach((socketIds) => {
    total += socketIds.size;
  });
  return total;
}

function getUsersPerRoom() {
  const usersPerRoom = {};
  rooms.forEach((socketIds, roomId) => {
    usersPerRoom[roomId] = socketIds.size;
  });
  return usersPerRoom;
}

function getUsersPerWebsite() {
  const usersPerWebsite = {};

  // Count from actual socket data
  rooms.forEach((socketIds, roomId) => {
    socketIds.forEach((socketId) => {
      const websiteName = socketWebsite.get(socketId);
      if (websiteName) {
        usersPerWebsite[websiteName] = (usersPerWebsite[websiteName] || 0) + 1;
      }
    });
  });

  return usersPerWebsite;
}

function getRoomUserCount(roomId) {
  const socketIds = rooms.get(roomId);
  return socketIds ? socketIds.size : 0;
}

async function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  console.log(`Room created: ${roomId}`);

  createChatRoomService(roomId);
  invalidateCache();
  scheduleAdminRoomUpdate();
  return { success: true, roomId };
}

async function deleteRoom(roomId) {
  if (!rooms.has(roomId)) {
    return { success: false, message: "Room does not exist" };
  }

  const socketIds = rooms.get(roomId);

  // Clean up website data for all users in this room
  socketIds.forEach((socketId) => {
    socketWebsite.delete(socketId);
  });

  const io = getIO();
  if (io) {
    io.to(roomId).emit("room_deleted", { roomId });
  }

  rooms.delete(roomId);
  deleteChatRoomService(roomId);

  invalidateCache();
  scheduleAdminRoomUpdate();
  roomUserCountUpdates.delete(roomId);
  return { success: true, roomId };
}

async function deleteAllRooms() {
  if (rooms.size === 0) {
    console.log("No Socket Rooms to Delete!");
    return { success: true, message: "No rooms to delete", deletedCount: 0 };
  }

  const roomIds = Array.from(rooms.keys());
  const deletedCount = roomIds.length;

  // Reset all data (no counters to reset)
  rooms.clear();
  socketWebsite.clear();

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

function joinRoom(roomId, socket, senderName, websiteName) {
  if (!rooms.has(roomId)) {
    return { success: false, message: "Room does not exist" };
  }

  const socketIds = rooms.get(roomId);
  socketIds.add(socket.id);

  // Store room ID and website name for this socket
  socket.roomId = roomId;

  // Store website name
  if (websiteName) {
    socketWebsite.set(socket.id, websiteName);
  }

  socket.join(roomId);

  // 🚨 NO MANUAL COUNTER UPDATES - everything derived from rooms Map

  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    success: true,
    roomId,
    usersCount: socketIds.size, // Direct from source of truth
  };
}

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms.has(roomId)) {
    return null;
  }

  const socketIds = rooms.get(roomId);
  socketIds.delete(socket.id);

  // Clean up website data
  socketWebsite.delete(socket.id);

  socket.leave(roomId);
  socket.roomId = null;

  // 🚨 NO MANUAL COUNTER UPDATES

  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    roomId,
    usersCount: socketIds.size, // Direct from source of truth
  };
}

function getUsersInRoom(roomId) {
  // Since we don't store senderNames, return count only
  return [];
}

function roomExists(roomId) {
  return rooms.has(roomId);
}

function updateViewsVisibility(data) {
  const io = getIO();
  if (io) {
    io.to(data?.roomId).emit("update_views_visibility", data?.data);
  }
}

// Admin management
function registerAdmin(socket) {
  adminSockets.add(socket);
  console.log("Admin registered:", socket.id);

  // Send cached data immediately
  const roomData = getCachedRoomData();
  socket.emit("admin_room_update", roomData);
}

function removeAdmin(socket) {
  adminSockets.delete(socket);
}

function scheduleAdminRoomUpdate() {
  if (adminUpdateTimeout) {
    clearTimeout(adminUpdateTimeout);
  }

  adminUpdateTimeout = setTimeout(() => {
    notifyAdminRoomUpdate();
  }, getCurrentPerformanceMode().settings.adminUpdateDebounce);
}

function notifyAdminRoomUpdate() {
  const roomData = getCachedRoomData();

  let sentCount = 0;
  adminSockets.forEach((adminSocket) => {
    if (adminSocket.connected) {
      adminSocket.emit("admin_room_update", roomData);
      sentCount++;
    }
  });

  console.log(`Admin room update sent to ${sentCount} admin(s)`);
}

// Smart caching
function getCachedRoomData() {
  const now = Date.now();

  if (
    cachedRoomData &&
    now - cachedRoomData.cacheTime <
      getCurrentPerformanceMode().settings.cacheTTL
  ) {
    return cachedRoomData;
  }

  cachedRoomData = {
    usersPerRoom: getUsersPerRoom(),
    usersPerWebsite: getUsersPerWebsite(),
    totalUsers: getTotalUsers(),
    totalRooms: rooms.size,
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
  const eventData = {
    ...data,
    timestamp: new Date().toISOString(),
    eventType: eventName,
  };

  let sentCount = 0;
  adminSockets.forEach((adminSocket) => {
    if (adminSocket.connected) {
      adminSocket.emit("admin_custom_event", eventData);
      sentCount++;
    }
  });

  return sentCount;
}

function emitToAdmin(socketId, eventName, data) {
  let sent = false;
  adminSockets.forEach((adminSocket) => {
    if (adminSocket.id === socketId && adminSocket.connected) {
      adminSocket.emit("admin_custom_event", {
        ...data,
        timestamp: new Date().toISOString(),
        eventType: eventName,
      });
      sent = true;
    }
  });
  return sent;
}

function scheduleUserCountUpdate(roomId, usersCount) {
  // Store the latest count for this room
  roomUserCountUpdates.set(roomId, usersCount);

  // Debounce updates
  if (userCountUpdateTimeout) {
    clearTimeout(userCountUpdateTimeout);
  }

  userCountUpdateTimeout = setTimeout(() => {
    broadcastUserCountUpdates();
  }, getCurrentPerformanceMode().settings.userCountUpdateDebounce);
}

function broadcastUserCountUpdates() {
  const io = getIO();
  if (!io) return;

  roomUserCountUpdates.forEach((usersCount, roomId) => {
    // Only broadcast if room still exists
    if (rooms.has(roomId)) {
      io.to(roomId).emit("room_user_count_update", {
        roomId,
        usersCount: usersCount,
      });
    }
  });

  roomUserCountUpdates.clear();
}

// Utility functions
let ioInstance = null;

function setIO(io) {
  ioInstance = io;
}

function getIO() {
  return ioInstance;
}

// Validation function to ensure counts are always correct
function validateCounts() {
  const calculatedTotal = getTotalUsers();
  const roomSum = Object.values(getUsersPerRoom()).reduce(
    (sum, count) => sum + count,
    0
  );
  const websiteSum = Object.values(getUsersPerWebsite()).reduce(
    (sum, count) => sum + count,
    0
  );

  console.log(`🔍 COUNT VALIDATION:`);
  console.log(`   totalUsers: ${calculatedTotal}`);
  console.log(`   Sum of rooms: ${roomSum}`);
  console.log(`   Sum of websites: ${websiteSum}`);

  // All should be equal - if not, there's a critical bug
  if (calculatedTotal !== roomSum || calculatedTotal !== websiteSum) {
    console.log(`🚨 CRITICAL: Count mismatch detected!`);
  } else {
    console.log(`✅ All counts are consistent`);
  }
}

// Run validation every 2 minutes
setInterval(validateCounts, 120000);

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
};
