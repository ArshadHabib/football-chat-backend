// socket/socketHandler.js
const mongoose = require("mongoose");
const { saveChatMessageService, applyReactionService } = require("@project/modules/chat/service");
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
const { pubClient: redis } = require("@project/config/redis");
const { getCurrentPerformanceMode } = require("@project/utils/perfomance_config");
const { findUserByName } = require("@project/modules/user/service");
const { BANNED_USERS_KEY } = require("@project/utils/const_config");

const REDIS_RATE_LIMIT_PREFIX = "ratelimit:";
const ALLOWED_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢", "😡"];

// Typing state: Map<roomId, Map<socketId, { username, timer }>>
const typingUsers = new Map();

function clearTypingUser(io, roomId, socketId) {
  const roomTyping = typingUsers.get(roomId);
  if (!roomTyping) return;
  const entry = roomTyping.get(socketId);
  if (!entry) return;
  clearTimeout(entry.timer);
  const { username } = entry;
  roomTyping.delete(socketId);
  if (roomTyping.size === 0) typingUsers.delete(roomId);
  io.to(roomId).emit("user_typing", { username, isTyping: false });
}

function setupSocketHandlers(io) {
  setIO(io);

  // Periodically evict typingUsers entries for rooms that have no connected sockets.
  // Handles the edge case where a room is abandoned without a clean typing_stop/disconnect.
  setInterval(() => {
    for (const [roomId, roomTyping] of typingUsers) {
      const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
      if (!socketsInRoom || socketsInRoom.size === 0) {
        for (const { timer } of roomTyping.values()) clearTimeout(timer);
        typingUsers.delete(roomId);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

        // Connection limits — remove this block to let max_memory_restart in ecosystem.config.js act as the only safety net
    if (io.engine.clientsCount > 15000) {
      socket.emit("error", { message: "Server at capacity" });
      socket.disconnect();
      return;
    }

        // Set IP at connection time — ensures rate limiting applies even if join_room is skipped
    let connIp =
      socket.handshake.headers["x-real-ip"] ||
      socket.handshake.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
      "";
    if (connIp.startsWith("::ffff:")) connIp = connIp.replace("::ffff:", "");
    socket.clientIp = connIp;

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
      if (!(await roomExists(roomId))) {
        socket.emit("error", { message: "Room does not exist" });
        return;
      }
      const msgId = new mongoose.Types.ObjectId();
            // Use senderName from admin data
      const messageData = {
        _id: msgId.toString(),
        senderName: "Admin",
        messageContent,
        roomId,
        isAdmin: true,
        isPinned: !!isPinned,
        timestamp: new Date().toISOString(),
      };
      io.to(roomId).emit("room_message", messageData);
      // Save message asynchronously
      saveChatMessageService(roomId, {
        _id: msgId,
        senderName: "Admin",
        senderId: socket.id,
        messageContent,
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
          message: "Missing or invalid parameters: roomId and userData are required",
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
      if (!(await roomExists(roomId))) {
        socket.emit("error", { message: "Room does not exist", roomId });
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

      // Upgrade to inComingClientIp (ipify.org) if provided — more accurate than headers.
      // Baseline IP from headers is already set at connection time.
      if (data.inComingClientIp) {
        socket.clientIp = data.inComingClientIp;
      }

      // Ban check on join disabled — banned users are allowed to join but cannot send messages.
      // The room_message pipeline blocks them via __banned_users__ Redis set check.
      // Uncomment below to re-enable join blocking (also restores self-healing for pre-existing bans).
      //
      // try {
      //   const inRedis = await redis.sIsMember(BANNED_USERS_KEY, senderName);
      //   if (inRedis) {
      //     socket.emit("join_result", { success: false, message: "You are banned from chat." });
      //     return;
      //   }
      //   const user = await findUserByName(senderName);
      //   if (!user || user.isBanned) {
      //     if (user?.isBanned) await redis.sAdd(BANNED_USERS_KEY, senderName);
      //     socket.emit("join_result", { success: false, message: "You are banned from chat." });
      //     return;
      //   }
      // } catch {
      //   socket.emit("join_result", { success: false, message: "Unable to verify user. Please try again." });
      //   return;
      // }

      // Store verified username on socket for server-side ban check in room_message.
      // Prevents banned users from bypassing the Redis ban check by spoofing senderName in the payload.
      // To use this, replace `socket.senderName ?? senderName` with `socket.senderName` in the
      // room_message pipeline check and remove the fallback.
      // socket.senderName = senderName;

      const result = await joinRoom(roomId, socket, senderName, websiteName);

      if (result.success) {
        socket.emit("join_result", result);
        scheduleUserCountUpdate(roomId);
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
      const { roomId, messageContent, senderName } = data;// senderName from frontend
      // Ban + rate limit check — single pipeline round trip
      const ip = socket.clientIp;
      const { rateLimitMax, rateLimitWindowSeconds } =
        getCurrentPerformanceMode().settings;
      const pipeline = redis.multi();
      // When socket.senderName fix is enabled, replace the line below with:
      // pipeline.sIsMember(BANNED_USERS_KEY, socket.senderName ?? senderName);
      pipeline.sIsMember(BANNED_USERS_KEY, senderName);
      if (ip) {
        const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;
        pipeline.incr(key);
        pipeline.expire(key, rateLimitWindowSeconds, "NX");
      }
      const results = await pipeline.exec();
      const isBanned = results[0];
      if (isBanned) return;
      if (ip) {
        const count = results[1];
        if (count > rateLimitMax) {
          const retryAfter = await redis.ttl(`${REDIS_RATE_LIMIT_PREFIX}${ip}`);
          socket.emit("server_rate_limit", {
            message: `Limit reached. Retry in ${retryAfter} seconds`,
            retryAfter,
          });
          return;
        }
      }
      if (await roomExists(roomId)) {
        const msgId = new mongoose.Types.ObjectId();
        const messageData = {
          _id: msgId.toString(),
          senderName,
          messageContent,
          roomId,
          timestamp: new Date().toISOString(),
        };
        // Broadcast to room including sender
        io.to(roomId).emit("room_message", messageData);
         // Save message asynchronously
        try {
          await saveChatMessageService(roomId, {
            _id: msgId,
            senderName, // Use from frontend
            senderId: socket.id,
            messageContent,
            messageType: "room_message",
          });
        } catch (error) {
          console.error("Failed to save message:", error);
        }
      }
    });

    socket.on("typing_start", (data) => {
      const { roomId, username } = data;
      if (!roomId || !username) return;
      if (!typingUsers.has(roomId)) typingUsers.set(roomId, new Map());
      const roomTyping = typingUsers.get(roomId);
      const existing = roomTyping.get(socket.id);
      const isNew = !existing;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => clearTypingUser(io, roomId, socket.id), 5000);
      roomTyping.set(socket.id, { username, timer });
      // Only broadcast on first start — heartbeat resets the timer without re-announcing
      if (isNew) io.to(roomId).emit("user_typing", { username, isTyping: true });
    });

    socket.on("typing_stop", (data) => {
      const { roomId } = data;
      if (!roomId) return;
      clearTypingUser(io, roomId, socket.id);
    });

    socket.on("add_reaction", async (data) => {
      const { roomId, messageId, emoji, username } = data;
      if (!roomId || !messageId || !emoji || !username) return;
      if (!ALLOWED_REACTIONS.includes(emoji)) return;

      const isBanned = await redis.sIsMember(BANNED_USERS_KEY, username);
      if (isBanned) return;

      try {
        const reactions = await applyReactionService(messageId, emoji, username);
        if (!reactions) return;
        io.to(roomId).emit("message_reaction_updated", { messageId, reactions });
      } catch (err) {
        console.error("Reaction error:", err);
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

      // Clean up typing for this socket across all rooms
      for (const [roomId] of typingUsers) {
        clearTypingUser(io, roomId, socket.id);
      }

      if (socket.isAdmin) {
        removeAdmin(socket);
      }

      const result = await leaveRoom(socket);
      if (result) {
        scheduleUserCountUpdate(result.roomId);
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
