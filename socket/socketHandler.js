// socket/socketHandler.js
const { saveChatMessageService } = require("@project/modules/chat/service");
const {
  joinRoom,
  leaveRoom,
  getUsersInRoom,
  roomExists,
  getTotalUsers,
  registerAdmin,
  getUsersPerRoom,
  removeAdmin,
  notifyAdminRoomUpdate,
  setIO,
  scheduleUserCountUpdate,
} = require("./roomManager");
const { authenticateToken } = require("@project/middleware");

function setupSocketHandlers(io) {
  setIO(io);

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Connection limits — remove this block to let max_memory_restart in ecosystem.config.js act as the only safety net
    if (io.engine.clientsCount > 15000) {
      socket.emit("error", { message: "Server at capacity" });
      socket.disconnect();
      return;
    }

    socket.on("admin_authenticate", async (data) => {
      const token = data?.token?.split(" ")?.[1];

      if (!token) {
        socket.emit("admin_authenticated", {
          success: false,
          message: "No token provided",
        });
        return;
      }

      try {
        const decodedToken = await authenticateToken(token);

        if (decodedToken?.userRoleFromToken === "admin") {
          await registerAdmin(socket);
          socket.isAdmin = true;
          socket.adminUser = {
            userId: decodedToken.userIdFromToken,
            role: decodedToken.userRoleFromToken,
          };

          socket.emit("admin_authenticated", {
            success: true,
            message: "Admin authentication successful",
            user: socket.adminUser,
          });
        } else {
          socket.emit("admin_authenticated", {
            success: false,
            message: "Admin privilege required",
          });
        }
      } catch (error) {
        console.error("Admin auth error:", error);
        socket.emit("admin_authenticated", {
          success: false,
          message: "Invalid or expired token",
        });
      }
    });

    socket.on("admin_join_room", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId } = data;
      socket.join(roomId);
      const perRoom = await getUsersPerRoom();
      socket.emit("admin_room_joined", {
        roomId,
        users: getUsersInRoom(roomId), // returns empty array (unchanged)
        usersCount: perRoom[roomId] || 0,
      });
    });

    socket.on("admin_leave_room", (data) => {
      if (!socket.isAdmin) return;
      const { roomId } = data;
      socket.leave(roomId);
      socket.emit("admin_room_left", { roomId });
    });

    socket.on("admin_room_message", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId, messageContent, isPinned } = data;

      if (!socket.rooms.has(roomId)) {
        socket.emit("error", {
          message: "You must join the room first before sending messages",
        });
        return;
      }

      if (!await roomExists(roomId)) {
        socket.emit("error", { message: "Room does not exist" });
        return;
      }

      // Use senderName from admin data
      const messageData = {
        senderName: "Admin",
        messageContent: messageContent,
        roomId: roomId,
        isAdmin: true,
        isPinned: !!isPinned,
        timestamp: new Date().toISOString(),
      };

      io.to(roomId).emit("room_message", messageData);

      // Save message asynchronously
      saveChatMessageService(roomId, {
        senderName: "Admin",
        senderId: socket.id,
        messageContent: messageContent,
        messageType: "room_message",
        isAdmin: true,
        isPinned: !!isPinned,
      }).catch(console.error);
    });

    socket.on("update_user", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId, userData } = data;

      // Validate required fields
      if (!roomId || !userData || typeof userData !== "object") {
        socket.emit("error", {
          message:
            "Missing or invalid parameters: roomId and userData are required",
        });
        return;
      }

      // Validate userData structure
      if (typeof userData.name === "undefined" || userData.name === null) {
        socket.emit("error", {
          message: "userData must contain at least a 'name' field",
        });
        return;
      }

      // Check if admin is in the room (optional but recommended)
      if (!socket.rooms.has(roomId)) {
        socket.emit("warning", {
          message: "You are not in this room, but broadcasting anyway",
          roomId,
        });
      }

      // Check if room exists
      if (!await roomExists(roomId)) {
        socket.emit("error", {
          message: "Room does not exist",
          roomId,
        });
        return;
      }

      // Prepare the broadcast data
      const broadcastData = {
        ...userData,
        roomId,
        updatedBy: "admin",
        timestamp: new Date().toISOString(),
        eventType: "user_updated",
      };

      // Broadcast to the specific room
      io.to(roomId).emit("user_updated", broadcastData);
    });

    // User joining room - websiteName still needed for analytics
    socket.on("join_room", async (data) => {
      const { senderName, roomId, websiteName } = data;
      const result = await joinRoom(roomId, socket, senderName, websiteName);

      if (result.success) {
        socket.emit("join_result", result);
        scheduleUserCountUpdate(roomId, result.usersCount);
        // socket.to(roomId).emit("user_joined", {
        //   senderName, // From frontend
        //   roomId,
        //   usersCount: result.usersCount || 0,
        // });
      } else {
        socket.emit("join_result", result);
      }
    });

    // Messages - senderName comes from frontend
    socket.on("room_message", async (data) => {
      const { roomId, messageContent, senderName } = data; // senderName from frontend

      if (await roomExists(roomId)) {
        const messageData = {
          senderName: senderName, // Use from frontend
          messageContent: messageContent,
          roomId,
          timestamp: new Date().toISOString(),
        };

        // Broadcast to room including sender
        io.to(roomId).emit("room_message", messageData);

        // Save message asynchronously
        try {
          await saveChatMessageService(roomId, {
            senderName: senderName, // Use from frontend
            senderId: socket.id,
            messageContent: messageContent,
            messageType: "room_message",
          });
        } catch (error) {
          console.error("Failed to save message:", error);
        }
      }
    });

    socket.on("update_views_visibility", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId, showViews } = data;
      if (await roomExists(roomId)) {
        io.to(roomId).emit("update_views_visibility", { showViews });
      }
    });

    socket.on("disconnect", async () => {
      console.log("User disconnected:", socket.id);

      if (socket.isAdmin) {
        removeAdmin(socket);
      }

      const result = await leaveRoom(socket);

      if (result) {
        scheduleUserCountUpdate(result.roomId, result.usersCount);
        // socket.to(result.roomId).emit("user_left", {
        //   // Note: We don't have senderName here anymore
        //   roomId: result.roomId,
        //   usersCount: result.usersCount || 0,
        // });
      }
    });

    socket.on("admin_request_data", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { dataType, parameters } = data;

      switch (dataType) {
        case "latest_matches":
          socket.emit("admin_custom_event", {
            eventType: "latest_matches_response",
            data: { message: "Fetching latest matches..." },
            timestamp: new Date().toISOString(),
          });
          break;
        case "force_room_update":
          await notifyAdminRoomUpdate();
          socket.emit("admin_custom_event", {
            eventType: "room_update_forced",
            data: { message: "Room update triggered manually" },
            timestamp: new Date().toISOString(),
          });
          break;
        default:
          socket.emit("error", { message: `Unknown data type: ${dataType}` });
      }
    });
  });
}

module.exports = setupSocketHandlers;
