// socket/roomManager.js
const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");
const {
  ADMIN_UPDATE_DEBOUNCE,
  USERS_COUNT_UPDATE_DEBOUNCE,
  CACHE_TTL,
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");

// Minimal data structures
const rooms = new Map(); // roomId -> Set of socketIds
const adminSockets = new Set();
const roomUserCountUpdates = new Map();

// Real-time counters
const roomCounts = new Map(); // roomId -> user count
const websiteCounts = new Map(); // websiteName -> user count
let totalUsers = 0;

// NEW: Store minimal socket info for website tracking
const socketWebsite = new Map(); // socketId -> websiteName

// Cache and debouncing
let cachedRoomData = null;
let adminUpdateTimeout = null;
let userCountUpdateTimeout = null;

async function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  roomCounts.set(roomId, 0);
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
  const userCount = socketIds.size;

  // Update website counts for all users in this room
  socketIds.forEach((socketId) => {
    const websiteName = socketWebsite.get(socketId);
    if (websiteName) {
      const count = websiteCounts.get(websiteName) || 0;
      if (count <= 1) {
        websiteCounts.delete(websiteName);
      } else {
        websiteCounts.set(websiteName, count - 1);
      }
      socketWebsite.delete(socketId);
    }
  });

  // Update counters
  totalUsers -= userCount;
  roomCounts.delete(roomId);

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

  // Reset all counters and data
  totalUsers = 0;
  rooms.clear();
  roomCounts.clear();
  websiteCounts.clear();
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

  // NEW: Store website name for this socket so we can decrement later
  if (websiteName) {
    socketWebsite.set(socket.id, websiteName);
  }

  socket.join(roomId);

  // Update counters - O(1) operations
  totalUsers++;
  roomCounts.set(roomId, socketIds.size);

  if (websiteName) {
    websiteCounts.set(websiteName, (websiteCounts.get(websiteName) || 0) + 1);
  }

  invalidateCache();
  scheduleAdminRoomUpdate();

  return {
    success: true,
    roomId,
    usersCount: socketIds.size,
  };
}

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms.has(roomId)) {
    return null;
  }

  const socketIds = rooms.get(roomId);
  socketIds.delete(socket.id);

  // NEW: Get website name for this socket and update website counts
  const websiteName = socketWebsite.get(socket.id);
  if (websiteName) {
    const count = websiteCounts.get(websiteName) || 0;
    if (count <= 1) {
      websiteCounts.delete(websiteName);
    } else {
      websiteCounts.set(websiteName, count - 1);
    }
    socketWebsite.delete(socket.id); // Clean up
  }

  // Update counters
  totalUsers = Math.max(0, totalUsers - 1);
  roomCounts.set(roomId, socketIds.size);

  socket.leave(roomId);
  socket.roomId = null;

  invalidateCache();
  scheduleAdminRoomUpdate();

  return { roomId, usersCount: socketIds.size };
}

// O(1) operations - no loops!
function getTotalUsers() {
  return totalUsers;
}

function getUsersInRoom(roomId) {
  // Since we don't store senderNames, return count only
  return [];
}

function roomExists(roomId) {
  return rooms.has(roomId);
}

// O(1) - uses pre-calculated counts
function getUsersPerRoom() {
  return Object.fromEntries(roomCounts);
}

// O(1) - uses pre-calculated counts
function getUsersPerWebsite() {
  return Object.fromEntries(websiteCounts);
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
  roomUserCountUpdates.set(roomId, {
    usersCount,
    lastUpdate: Date.now(),
  });

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

  roomUserCountUpdates.forEach((data, roomId) => {
    // Only broadcast if room still exists and has users
    if (rooms.has(roomId)) {
      io.to(roomId).emit("room_user_count_update", {
        roomId,
        usersCount: data.usersCount,
      });
    }
  });
  // console.log(
  //   `📊 User count updates sent to ${roomUserCountUpdates.size} rooms`
  // );
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
