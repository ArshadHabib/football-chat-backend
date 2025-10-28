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
  setIO,
} = require("./roomManager");
const { authenticateToken } = require("@project/middleware");

function setupSocketHandlers(io) {
  // Make io available to roomManager
  setIO(io);

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

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
          registerAdmin(socket);
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
          console.log(
            "Admin authenticated:",
            socket.id,
            socket.adminUser.userId
          );
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

    // Handle admin joining a room (for monitoring)
    socket.on("admin_join_room", (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId } = data;
      socket.join(roomId);
      socket.emit("admin_room_joined", {
        roomId,
        users: getUsersInRoom(roomId),
        usersCount: getUsersPerRoom()[roomId] || 0,
      });
      console.log(`Admin ${socket.id} joined room: ${roomId}`);
    });

    // Handle admin leaving a room
    socket.on("admin_leave_room", (data) => {
      if (!socket.isAdmin) return;

      const { roomId } = data;
      socket.leave(roomId);
      socket.emit("admin_room_left", { roomId });
    });

    // Handle admin sending message to room
    socket.on("admin_room_message", (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId, messageContent } = data;

      if (!socket.rooms.has(roomId)) {
        socket.emit("error", {
          message: "You must join the room first before sending messages",
        });
        return;
      }

      if (!roomExists(roomId)) {
        socket.emit("error", { message: "Room does not exist" });
        return;
      }

      // Use room broadcast instead of looping
      const messageData = {
        senderName: "Admin",
        messageContent: messageContent,
        roomId: roomId,
        isAdmin: true,
        timestamp: new Date().toISOString(),
      };

      io.to(roomId).emit("room_message", messageData);

      // Save message asynchronously
      saveChatMessageService(roomId, {
        senderName: "Admin",
        senderId: socket.id,
        messageContent: messageContent,
        messageType: "room_message",
      }).catch(console.error);

      console.log(
        `Admin ${socket.adminUser.userId} sent message to room ${roomId}`
      );
    });

    // Handle user joining room
    socket.on("join_room", (data) => {
      const { senderName, roomId, websiteName } = data;
      const result = joinRoom(roomId, socket, senderName, websiteName);

      if (result.success) {
        socket.emit("join_result", result);

        // Notify others in the room
        socket.to(roomId).emit("user_joined", {
          senderName,
          roomId,
          usersCount: result.usersCount || 0,
        });
      } else {
        socket.emit("join_result", result);
      }
    });

    // Handle messages to room
    socket.on("room_message", async (data) => {
      const { roomId, messageContent, senderName } = data;

      if (roomExists(roomId)) {
        const messageData = {
          senderName: senderName,
          messageContent: messageContent,
          roomId,
        };

        // Emit to room (excluding sender)
        socket.to(roomId).emit("room_message", messageData);

        // Save message asynchronously
        try {
          await saveChatMessageService(roomId, {
            senderName: senderName,
            senderId: socket.id,
            messageContent: messageContent,
            messageType: "room_message",
          });
        } catch (error) {
          console.error("Failed to save message:", error);
        }
      }
    });

    // Handle views visibility update to room
    socket.on("update_views_visibility", (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { roomId, showViews } = data;
      if (roomExists(roomId)) {
        io.to(roomId).emit("update_views_visibility", { showViews });
      }
    });

    // Handle user disconnection
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);

      if (socket.isAdmin) {
        removeAdmin(socket);
      }

      const result = leaveRoom(socket.id);

      if (result) {
        // Notify others in the room
        socket.to(result.roomId).emit("user_left", {
          senderName: socket.senderName,
          roomId: result.roomId,
          usersCount: result.usersCount || 0,
        });
      }
    });

    // Add this new event for admin to request specific data
    socket.on("admin_request_data", (data) => {
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
        default:
          socket.emit("error", { message: `Unknown data type: ${dataType}` });
      }
    });
  });
}

module.exports = setupSocketHandlers;
