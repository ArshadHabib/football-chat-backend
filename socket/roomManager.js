const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");

// Room management functions
const rooms = new Map();
const adminSockets = new Set();

async function createRoom(roomId) {
  if (rooms.has(roomId)) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  console.log(`Room created: ${roomId}`);
  createChatRoomService(roomId);
  notifyAdminRoomUpdate();
  return { success: true, roomId };
}

async function deleteRoom(roomId) {
  if (!rooms.has(roomId)) {
    return { success: false, message: "Room does not exist" };
  }

  // Notify all users in the room before deleting
  console.log(`Room deleted: ${roomId}`);
  const userSet = rooms.get(roomId);
  userSet.forEach((socket) => {
    socket.emit("room_deleted", { roomId });
    socket.leave(roomId);
    socket.roomId = null;
  });

  rooms.delete(roomId);
  deleteChatRoomService(roomId);
  notifyAdminRoomUpdate();
  return { success: true, roomId };
}

async function deleteAllRooms() {
  if (rooms.size === 0) {
    console.log("No Socket Rooms to Delete!");
    return { success: true, message: "No rooms to delete", deletedCount: 0 };
  }

  const deletedRooms = [];
  const roomCount = rooms.size;

  // Iterate through all rooms and delete them
  rooms.forEach((userSet, roomId) => {
    // Notify all users in the room before deleting
    userSet.forEach((socket) => {
      socket.emit("room_deleted", { roomId });
      socket.leave(roomId);
      socket.roomId = null;
    });

    // Delete from database service
    deleteChatRoomService(roomId);

    deletedRooms.push(roomId);
  });

  // Clear all rooms from the Map
  rooms.clear();

  console.log(`All ${roomCount} rooms deleted: ${deletedRooms.join(", ")}`);
  notifyAdminRoomUpdate();

  return {
    success: true,
    message: `All ${roomCount} rooms deleted successfully`,
    deletedCount: roomCount,
    deletedRooms: deletedRooms,
  };
}

function joinRoom(roomId, socket, senderName) {
  if (!rooms.has(roomId)) {
    return { success: false, message: "Room does not exist" };
  }

  const userSet = rooms.get(roomId);
  socket.senderName = senderName;
  userSet.add(socket);
  socket.roomId = roomId;
  socket.join(roomId);

  // return {
  //   success: true,
  //   roomId,
  //   users: Array.from(userSet).map((s) => s.senderName),
  // };
  notifyAdminRoomUpdate();
  return {
    success: true,
    roomId,
    usersCount: userSet?.size || 0,
  };
}

function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const userSet = rooms.get(roomId);
  userSet.delete(socket);

  // Clean up empty rooms
  //   if (userSet.size === 0) {
  //     rooms.delete(roomId);
  //   }

  socket.leave(roomId);
  socket.roomId = null;
  notifyAdminRoomUpdate();

  // return { roomId, users: Array.from(userSet).map((s) => s.senderName) };
  return { roomId, usersCount: userSet?.size || 0 };
}

function getTotalUsers() {
  let totalUsers = 0;
  rooms?.forEach((userSet) => {
    totalUsers += userSet?.size || 0;
  });
  return totalUsers;
}

function getUsersInRoom(roomId) {
  if (!rooms.has(roomId)) {
    return [];
  }

  const userSet = rooms.get(roomId);
  return Array.from(userSet).map((socket) => socket.senderName);
}

function roomExists(roomId) {
  return rooms.has(roomId);
}

function getUsersPerRoom() {
  const usersPerRoom = {};

  rooms.forEach((userSet, roomId) => {
    usersPerRoom[roomId] = userSet.size || 0;
  });

  return usersPerRoom;
}

// Admin management functions
function registerAdmin(socket) {
  adminSockets.add(socket);
  console.log("Admin registered:", socket.id);
  // Send current state to new admin
  socket.emit("admin_room_update", {
    usersPerRoom: getUsersPerRoom(),
    totalUsers: getTotalUsers(),
    totalRooms: rooms.size,
  });
}

function removeAdmin(socket) {
  adminSockets.delete(socket);
  console.log("Admin removed:", socket.id);
}

function notifyAdminRoomUpdate() {
  const roomData = {
    usersPerRoom: getUsersPerRoom(),
    totalUsers: getTotalUsers(),
    totalRooms: rooms.size,
    timestamp: new Date().toISOString(),
  };

  // Send update to all connected admins
  adminSockets.forEach((adminSocket) => {
    if (adminSocket.connected) {
      adminSocket.emit("admin_room_update", roomData);
    }
  });
}

function isAdmin(socket) {
  return adminSockets.has(socket);
}

// Function to send custom data to all connected admins
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

  console.log(`[Admin Event] "${eventName}" sent to ${sentCount} admin(s)`);
  return sentCount;
}

// Function to send data to specific admin by socket ID
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
      console.log(`[Admin Event] "${eventName}" sent to admin ${socketId}`);
    }
  });
  return sent;
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
};
