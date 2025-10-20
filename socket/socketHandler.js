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
} = require("./roomManager");
const { authenticateToken } = require("@project/middleware");

function setupSocketHandlers(io) {
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

      // Verify admin token (you should use a more secure method in production)
      try {
        const decodedToken = await authenticateToken(token);

        // Check if user has admin role
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
            user: {
              userId: decodedToken.userIdFromToken,
              role: decodedToken.userRoleFromToken,
            },
          });
          console.log(
            "Admin authenticated:",
            socket.id,
            decodedToken.userIdFromToken
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

      // Check if admin has joined this room
      if (!socket.rooms.has(roomId)) {
        socket.emit("error", {
          message: "You must join the room first before sending messages",
        });
        return;
      }

      // Check if room exists
      if (!roomExists(roomId)) {
        socket.emit("error", { message: "Room does not exist" });
        return;
      }

      // Broadcast message to the room with admin identification
      io.to(roomId).emit("room_message", {
        senderName: "Admin", // or use socket.adminUser.name if available
        messageContent: messageContent,
        roomId: roomId,
        isAdmin: true, // Flag to identify admin messages
        timestamp: new Date().toISOString(),
      });

      // Also send to admin monitoring feed
      // io.to(roomId).sockets.forEach((s) => {
      //   if (s.isAdmin && s.rooms.has(roomId)) {
      //     s.emit("admin_room_message", {
      //       senderName: "Admin",
      //       messageContent: message,
      //       roomId: roomId,
      //       isAdmin: true,
      //       timestamp: new Date().toISOString(),
      //     });
      //   }
      // });

      console.log(
        `Admin ${socket.adminUser.userId} sent message to room ${roomId}: ${messageContent}`
      );
    });

    // Handle user joining room
    socket.on("join_room", (data) => {
      const { senderName, roomId } = data;
      const result = joinRoom(roomId, socket, senderName);
      console.log("Users Count:", getTotalUsers());

      if (result.success) {
        // Notify the user who joined
        socket.emit("join_result", result);

        // Notify others in the room
        socket.to(roomId).emit("user_joined", {
          senderName,
          roomId,
          // users: result.users,
          usersCount: result.usersCount || 0,
        });
      } else {
        socket.emit("join_result", result);
      }
    });

    // Handle messages to room
    socket.on("room_message", (data) => {
      const { roomId, messageContent } = data;

      if (roomExists(roomId)) {
        socket.to(roomId).emit("room_message", {
          senderName: socket.senderName,
          messageContent: messageContent,
          roomId,
        });
        saveChatMessageService(roomId, {
          senderName: socket.senderName,
          senderId: socket.id,
          messageContent: messageContent,
          messageType: "room_message",
        });
        // Also send message to admins monitoring this room
        if (socket.isAdmin) {
          // Don't echo admin's own messages back
          return;
        }
        // io?.to(roomId)?.sockets?.forEach((s) => {
        //   if (s?.isAdmin && s?.rooms?.has(roomId)) {
        //     s.emit("admin_room_message", {
        //       senderName: socket.senderName,
        //       messageContent: messageContent,
        //       roomId,
        //       timestamp: new Date().toISOString(),
        //     });
        //   }
        // });
      }
    });

    // Handle user disconnection
    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);

      // Remove admin if this was an admin socket
      if (socket.isAdmin) {
        removeAdmin(socket);
      }

      if (socket.roomId) {
        const result = leaveRoom(socket);
        console.log("Users Count:", getTotalUsers());

        if (result) {
          // Notify others in the room
          socket.to(result.roomId).emit("user_left", {
            senderName: socket.senderName,
            roomId: result.roomId,
            // users: result.users,
            usersCount: result.usersCount || 0,
          });
        }
      }
    });

    // Add this new event for admin to request specific data
    socket.on("admin_request_data", (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }

      const { dataType, parameters } = data;

      // You can handle different data requests here
      switch (dataType) {
        case "latest_matches":
          // Trigger your matches service and emit back
          // This is just an example - you'll call your actual service
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
