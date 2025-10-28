// socket/roomManager.js
const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");

// Use more efficient data structures
const rooms = new Map(); // roomId -> Set of socketIds
const socketData = new Map(); // socketId -> { roomId, senderName, websiteName, isAdmin, etc. }
const adminSockets = new Set();
const websiteCounts = new Map(); // websiteName -> count

// Cache for admin room updates to avoid recalculating
let cachedRoomData = null;
let lastRoomUpdate = 0;
const ROOM_UPDATE_DEBOUNCE = 1000; // 1 second

async function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  console.log(`Room created: ${roomId}`);
  createChatRoomService(roomId);
  invalidateRoomCache();
  return { success: true, roomId };
}

async function deleteRoom(roomId) {
  if (!rooms.has(roomId)) {
    return { success: false, message: "Room does not exist" };
  }

  const socketIds = rooms.get(roomId);

  // Batch operations instead of individual emits
  const socketPromises = Array.from(socketIds).map((socketId) => {
    const socket = getSocketById(socketId);
    if (socket) {
      socket.emit("room_deleted", { roomId });
      socket.leave(roomId);
      updateSocketData(socketId, { roomId: null });
    }
  });

  await Promise.all(socketPromises);

  rooms.delete(roomId);
  deleteChatRoomService(roomId);
  invalidateRoomCache();
  return { success: true, roomId };
}

async function deleteAllRooms() {
  if (rooms.size === 0) {
    console.log("No Socket Rooms to Delete!");
    return { success: true, message: "No rooms to delete", deletedCount: 0 };
  }

  const roomIds = Array.from(rooms.keys());
  const deletedCount = roomIds.length;

  // Batch delete operations
  const deletePromises = roomIds.map((roomId) => deleteRoom(roomId));
  await Promise.all(deletePromises);

  console.log(`All ${deletedCount} rooms deleted`);
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
  const socketId = socket.id;

  // Update socket data
  updateSocketData(socketId, {
    roomId,
    senderName,
    websiteName,
    socket, // store reference if needed
  });

  socketIds.add(socketId);
  socket.join(roomId);

  // Update website counts efficiently
  if (websiteName) {
    websiteCounts.set(websiteName, (websiteCounts.get(websiteName) || 0) + 1);
  }

  invalidateRoomCache();
  return {
    success: true,
    roomId,
    usersCount: socketIds.size,
  };
}

function leaveRoom(socketId) {
  const data = socketData.get(socketId);
  if (!data || !data.roomId) return null;

  const roomId = data.roomId;
  if (!rooms.has(roomId)) return null;

  const socketIds = rooms.get(roomId);
  socketIds.delete(socketId);

  // Update website counts
  if (data.websiteName) {
    const count = websiteCounts.get(data.websiteName) || 1;
    if (count <= 1) {
      websiteCounts.delete(data.websiteName);
    } else {
      websiteCounts.set(data.websiteName, count - 1);
    }
  }

  // Clean up socket data
  socketData.delete(socketId);
  invalidateRoomCache();

  return { roomId, usersCount: socketIds.size };
}

function getTotalUsers() {
  let total = 0;
  for (const socketIds of rooms.values()) {
    total += socketIds.size;
  }
  return total;
}

function getUsersInRoom(roomId) {
  if (!rooms.has(roomId)) return [];

  const socketIds = rooms.get(roomId);
  const users = [];

  for (const socketId of socketIds) {
    const data = socketData.get(socketId);
    if (data && data.senderName) {
      users.push(data.senderName);
    }
  }

  return users;
}

function roomExists(roomId) {
  return rooms.has(roomId);
}

function getUsersPerRoom() {
  const usersPerRoom = {};
  for (const [roomId, socketIds] of rooms) {
    usersPerRoom[roomId] = socketIds.size;
  }
  return usersPerRoom;
}

function getUsersPerWebsite() {
  return Object.fromEntries(websiteCounts);
}

function updateViewsVisibility(data) {
  const socketIds = rooms.get(data?.roomId);
  if (!socketIds) return;

  // Batch emit to room
  const io = getIO(); // You'll need to make io available
  if (io) {
    io.to(data.roomId).emit("update_views_visibility", data?.data);
  }
}

// Admin management functions
function registerAdmin(socket) {
  adminSockets.add(socket.id);
  updateSocketData(socket.id, { isAdmin: true });

  // Send cached room data if available
  if (cachedRoomData) {
    socket.emit("admin_room_update", cachedRoomData);
  } else {
    socket.emit("admin_room_update", getRoomData());
  }
}

function removeAdmin(socket) {
  adminSockets.delete(socket.id);
}

function notifyAdminRoomUpdate() {
  const now = Date.now();
  if (now - lastRoomUpdate < ROOM_UPDATE_DEBOUNCE) {
    return; // Debounce updates
  }

  lastRoomUpdate = now;
  cachedRoomData = getRoomData();

  // Batch emit to all admins
  const io = getIO();
  if (io && adminSockets.size > 0) {
    const adminRoom = "admin_room"; // Consider using a room for admins
    io.to(Array.from(adminSockets)).emit("admin_room_update", cachedRoomData);
  }
}

function getRoomData() {
  return {
    usersPerRoom: getUsersPerRoom(),
    usersPerWebsite: getUsersPerWebsite(),
    totalUsers: getTotalUsers(),
    totalRooms: rooms.size,
    timestamp: new Date().toISOString(),
  };
}

function invalidateRoomCache() {
  cachedRoomData = null;
}

function isAdmin(socket) {
  const data = socketData.get(socket.id);
  return !!(data && data.isAdmin);
}

// Efficient admin emissions using rooms
function emitToAdmins(eventName, data) {
  const eventData = {
    ...data,
    timestamp: new Date().toISOString(),
    eventType: eventName,
  };

  const io = getIO();
  if (!io || adminSockets.size === 0) return 0;

  io.to(Array.from(adminSockets)).emit("admin_custom_event", eventData);
  console.log(
    `[Admin Event] "${eventName}" sent to ${adminSockets.size} admin(s)`
  );
  return adminSockets.size;
}

function emitToAdmin(socketId, eventName, data) {
  const io = getIO();
  if (!io || !adminSockets.has(socketId)) return false;

  io.to(socketId).emit("admin_custom_event", {
    ...data,
    timestamp: new Date().toISOString(),
    eventType: eventName,
  });

  console.log(`[Admin Event] "${eventName}" sent to admin ${socketId}`);
  return true;
}

// Utility functions
function getSocketById(socketId) {
  // You'll need to make socket instances available here
  // This depends on your Socket.IO setup
  const io = getIO();
  return io?.sockets?.sockets?.get(socketId);
}

function updateSocketData(socketId, updates) {
  const existing = socketData.get(socketId) || {};
  socketData.set(socketId, { ...existing, ...updates });
}

function setIO(ioInstance) {
  global.socketIO = ioInstance;
}

function getIO() {
  return global.socketIO;
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
  setIO, // Call this in your main socket setup
};
