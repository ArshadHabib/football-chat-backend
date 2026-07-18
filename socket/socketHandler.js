// socket/socketHandler.js
const mongoose = require("mongoose");
const {
  saveChatMessageService,
  applyReactionService,
  applyAdminReactionService,
  readAdminSnapshot,
} = require("@project/modules/chat/service");
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
const { findUserByName } = require("@project/modules/user/service");
const {
  BANNED_USERS_KEY,
  REDIS_ROOMS_SET,
} = require("@project/utils/const_config");
const {
  validateMessage,
  sanitizeReplyTo,
} = require("@project/utils/messageValidation");
const {
  getFlag,
  FEATURE_VALIDATION,
  FEATURE_AIMOD,
  onFlagChange,
} = require("@project/utils/feature_flags");
const {
  getConfig: getRateLimitConfig,
  onConfigChange: onRateLimitChange,
} = require("@project/utils/rate_limit_config");
const moderationService = require("@project/modules/moderation/service");

const REDIS_RATE_LIMIT_PREFIX = "ratelimit:";
const ALLOWED_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢", "😡", "🖕"];
const RECENT_MESSAGES_BUFFER = 5;

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

  // Forward validation-flag changes to connected sockets. Each PM2 instance
  // already receives the __feature_change__ Redis pub/sub message
  // independently (via featuresSubClient in feature_flags.js), so io.emit()
  // would fan out cluster-wide via the socket.io Redis adapter and produce
  // N×N broadcasts. io.local.emit restricts to this instance's sockets —
  // 1:N per instance, N×1 total. Only the validation flag is exposed to
  // clients; registration stays server-internal.
  onFlagChange((name, value) => {
    if (name !== FEATURE_VALIDATION) return;
    io.local.emit("validation_changed", { value: !!value });
  });

  // Forward message rate-limit config changes to connected sockets. Same
  // io.local.emit reasoning as validation_changed above: each PM2 instance
  // independently receives the __rate_limit_change__ Redis pub/sub message, so
  // io.emit() would fan out cluster-wide via the adapter and produce N×N
  // broadcasts. io.local.emit keeps it 1:N per instance, N×1 total.
  onRateLimitChange((cfg) => {
    io.local.emit("rate_limit_changed", cfg); // { enabled, max, windowSeconds }
  });

  // Periodically evict typingUsers entries for rooms that have no connected sockets.
  // Handles the edge case where a room is abandoned without a clean typing_stop/disconnect.
  setInterval(
    () => {
      for (const [roomId, roomTyping] of typingUsers) {
        const socketsInRoom = io.sockets.adapter.rooms.get(roomId);
        if (!socketsInRoom || socketsInRoom.size === 0) {
          for (const { timer } of roomTyping.values()) clearTimeout(timer);
          typingUsers.delete(roomId);
        }
      }
    },
    5 * 60 * 1000,
  ); // every 5 minutes

  io.on("connection", (socket) => {
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
      const { roomId, messageContent, isPinned, replyTo } = data;
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
      // Admin messages aren't gated by FEATURE_VALIDATION (admins aren't bots),
      // so the reply snippet is sanitised without profanity cleaning — only
      // length + type bounds are enforced.
      const sanitizedReply = sanitizeReplyTo(replyTo);
      const msgId = new mongoose.Types.ObjectId();
      const messageData = {
        _id: msgId.toString(),
        senderName: "Admin",
        messageContent,
        roomId,
        isAdmin: true,
        isPinned: !!isPinned,
        timestamp: new Date().toISOString(),
        ...(sanitizedReply && { replyTo: sanitizedReply }),
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
        ...(sanitizedReply && { replyTo: sanitizedReply }),
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

      // inComingClientIp override removed — client-supplied value (ipify.org)
      // can be spoofed by a scripted client to bypass per-IP rate limit,
      // IP ban, and banAllUsersByIp cascade. socket.clientIp set at connection
      // time from x-real-ip / x-forwarded-for (nginx-forwarded) is the only
      // trusted source.
      // if (data.inComingClientIp) {
      //   socket.clientIp = data.inComingClientIp;
      // }

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
        // Surface current validation flag so the client can mirror it as its
        // non-essential-validation local state. Other flags stay server-internal.
        result.validation = !!getFlag(FEATURE_VALIDATION);
        // Surface the current message rate-limit config so the client mirrors
        // it (enable/disable + the two numbers). Old clients ignore this field.
        result.rateLimit = getRateLimitConfig(); // { enabled, max, windowSeconds }
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
      const { roomId, messageContent, senderName, replyTo } = data;
      // Ban + room existence + rate limit — single pipeline round trip
      const ip = socket.clientIp;
      // Message rate-limit config is admin-controlled + cluster-synced
      // (utils/rate_limit_config.js). When disabled, the per-IP counter isn't
      // touched at all — the incr/expire/ttl commands are never queued, so
      // toggling off is a clean no-op (and 3 fewer Redis ops per message).
      const rl = getRateLimitConfig(); // { enabled, max, windowSeconds }
      const rateLimitActive = rl.enabled && !!ip;
      const pipeline = redis.multi();
      // When socket.senderName fix is enabled, replace the line below with:
      // pipeline.sIsMember(BANNED_USERS_KEY, socket.senderName ?? senderName);
      pipeline.sIsMember(BANNED_USERS_KEY, senderName); // [0]
      pipeline.sIsMember(REDIS_ROOMS_SET, roomId); // [1]
      if (rateLimitActive) {
        const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;
        pipeline.incr(key); // [2]
        pipeline.expire(key, rl.windowSeconds, "NX"); // [3]
        pipeline.ttl(key); // [4] — inlined so both rejection and at-cap
                           //       paths get the cooldown without an extra RTT
      }
      const results = await pipeline.exec();
      const isBanned = results[0];
      if (isBanned) return;
      const roomStillExists = results[1];
      if (!roomStillExists) return;
      if (rateLimitActive) {
        const count = results[2];
        const retryAfter = results[4];
        if (count > rl.max) {
          // Rejection path — message dropped.
          socket.emit("server_rate_limit", {
            message: `Limit reached. Retry in ${retryAfter} seconds`,
            retryAfter,
          });
          return;
        }
        if (count === rl.max) {
          // Admit path — message still gets broadcast below, but pre-emptively
          // tell the client they've hit the cap so the inline countdown shows
          // and the Send button disables. Eliminates the "ghost message"
          // problem for the normal case (next send would otherwise hit the
          // rejection path and the sender's optimistic message would linger
          // even though the server dropped it).
          socket.emit("server_rate_limit", {
            message: `Limit reached. Retry in ${retryAfter} seconds`,
            retryAfter,
          });
          // fall through — broadcast this message normally
        }
      }

      // AI moderation report (AI_MODERATION_PLAN.md): a reply that mentions
      // @admin is a report — Gemini judges the ORIGINAL message and auto-bans
      // on a confirmed violation. Detected on the RAW inbound payload here,
      // BEFORE the FEATURE_VALIDATION drop below — a report is a control
      // signal and must not be silently swallowed just because its text trips
      // a spam heuristic. Runs after the ban/room/rate-limit gates (banned or
      // rate-limited senders don't get to report). Flag-gated first so a
      // disabled feature adds zero regex/allocation cost to the reply path.
      // Fire-and-forget; the full guard chain (cooldown, budget, cluster
      // dedupe, target checks) lives inside handleReport. Only messageId is
      // consumed (already ObjectId-validated by sanitizeReplyTo), so the
      // report is independent of whether the reply itself gets broadcast.
      // Fully isolated from the message flow: the whole detection block is
      // wrapped so NO moderation error (sync throw or otherwise) can ever
      // abort the reply's broadcast/persist below. handleReport is also
      // fire-and-forget with its own .catch. Chat keeps running no matter what
      // the moderation path does.
      try {
        if (getFlag(FEATURE_AIMOD) && replyTo) {
          const reportReply = sanitizeReplyTo(replyTo);
          if (
            reportReply &&
            moderationService.detectAdminReport({
              messageContent,
              replyTo: reportReply,
            })
          ) {
            moderationService
              .handleReport({
                io,
                roomId,
                reporterName: senderName,
                reporterIp: ip,
                replyTo: reportReply,
              })
              .catch((err) => console.error("aimod handleReport error:", err));
          }
        }
      } catch (err) {
        console.error("aimod detection error (chat unaffected):", err);
      }

      // Server-side content handling — gated entirely on the
      // FEATURE_VALIDATION flag. When ON: heuristic drops + profanity
      // censoring (cleanString) both run. When OFF: nothing runs, raw
      // content is broadcast as the client sent it. Admin flips the flag
      // cluster-wide via Redis pub/sub without restarting the backend.
      // Default OFF (see utils/feature_flags.js DEFAULTS). Drops are
      // silent — no error emit, gives bots no feedback to tune against.
      // Strike counter / auto-ban deferred to Phase 2.3.
      let outputContent;
      const validationOn = getFlag(FEATURE_VALIDATION);
      if (validationOn) {
        socket.recentMessages = socket.recentMessages || [];
        const verdict = validateMessage(messageContent, socket.recentMessages);
        if (!verdict.ok) return;
        socket.recentMessages = [
          ...socket.recentMessages.slice(-(RECENT_MESSAGES_BUFFER - 1)),
          verdict.normalized,
        ];
        outputContent = verdict.cleaned;
      } else {
        outputContent = messageContent;
      }

      // Reply snippet sanitisation. Cleans profanity only when FEATURE_VALIDATION
      // is on — same contract as the message body. Returns null for absent /
      // malformed replyTo, in which case the spread below omits the field.
      const sanitizedReply = sanitizeReplyTo(replyTo, {
        shouldClean: validationOn,
      });

      const msgId = new mongoose.Types.ObjectId();
      const messageData = {
        _id: msgId.toString(),
        senderName,
        messageContent: outputContent,
        roomId,
        timestamp: new Date().toISOString(),
        ...(sanitizedReply && { replyTo: sanitizedReply }),
      };
      // Broadcast immediately — message is already live
      io.to(roomId).emit("room_message", messageData);
      // Save asynchronously — handler returns now, save continues in background.
      // Persist the cleaned content (matches what was broadcast) so message
      // history loaded later via fetchChatMessages displays the same text.
      saveChatMessageService(roomId, {
        _id: msgId,
        senderName,
        senderId: socket.id,
        messageContent: outputContent,
        messageType: "room_message",
        ...(sanitizedReply && { replyTo: sanitizedReply }),
      }).catch((error) => console.error("Failed to save message:", error));
    });

    socket.on("typing_start", (data) => {
      const { roomId, username } = data;
      if (!roomId || !username) return;
      if (!typingUsers.has(roomId)) typingUsers.set(roomId, new Map());
      const roomTyping = typingUsers.get(roomId);
      const existing = roomTyping.get(socket.id);
      const isNew = !existing;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(
        () => clearTypingUser(io, roomId, socket.id),
        5000,
      );
      roomTyping.set(socket.id, { username, timer });
      // Only broadcast on first start — heartbeat resets the timer without re-announcing
      if (isNew)
        io.to(roomId).emit("user_typing", { username, isTyping: true });
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
        const reactions = await applyReactionService(
          messageId,
          emoji,
          username,
        );
        if (!reactions) return;
        // Include adminReactions snapshot so listeners that spread the payload
        // into state don't clobber existing admin counts.
        io.to(roomId).emit("message_reaction_updated", {
          messageId,
          reactions,
          adminReactions: readAdminSnapshot(messageId),
        });
      } catch (err) {
        console.error("Reaction error:", err);
      }
    });

    socket.on("admin_add_reaction", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }
      const { roomId, messageId, emoji, delta } = data || {};
      if (!roomId || !messageId || !emoji) return;
      if (!ALLOWED_REACTIONS.includes(emoji)) return;

      // Accept a delta from a debounced client. Default 1, no upper cap.
      const n = Math.max(parseInt(delta, 10) || 1, 1);

      try {
        const result = await applyAdminReactionService(messageId, emoji, n);
        if (!result) return;
        io.to(roomId).emit("message_reaction_updated", {
          messageId,
          reactions: result.reactions,
          adminReactions: result.adminReactions,
        });
      } catch (err) {
        console.error("Admin add reaction error:", err);
      }
    });

    socket.on("admin_remove_reaction", async (data) => {
      if (!socket.isAdmin) {
        socket.emit("error", { message: "Admin access required" });
        return;
      }
      const { roomId, messageId, emoji, delta } = data || {};
      if (!roomId || !messageId || !emoji) return;
      if (!ALLOWED_REACTIONS.includes(emoji)) return;

      const n = Math.max(parseInt(delta, 10) || 1, 1);

      try {
        const result = await applyAdminReactionService(messageId, emoji, -n);
        if (!result) return;
        io.to(roomId).emit("message_reaction_updated", {
          messageId,
          reactions: result.reactions,
          adminReactions: result.adminReactions,
        });
      } catch (err) {
        console.error("Admin remove reaction error:", err);
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
