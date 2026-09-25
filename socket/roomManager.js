// socket/roomManager.js
const {
  createChatRoomService,
  deleteChatRoomService,
} = require("@project/modules/chat/service");
const {
  getCurrentPerformanceMode,
} = require("@project/utils/perfomance_config");
const { pubClient: redis } = require("@project/config/redis");
const {
  getFlag,
  FEATURE_USERS_COUNT,
} = require("@project/utils/feature_flags");
const {
  REDIS_ROOM_MSG_COUNTS,
  REDIS_ROOM_LAST_ACTIVITY,
  REDIS_ROOM_MSG_COUNTS_DRAIN,
  REDIS_ROOM_LAST_ACTIVITY_DRAIN,
  DRAIN_LOCK_KEY,
  REDIS_MSG_CACHE_PREFIX,
  REDIS_PINNED_MSG_PREFIX,
  REDIS_ROOMS_SET,
  REDIS_WEBSITE_COUNTS,
} = require("@project/utils/const_config");

// === LOCAL SOCKET TRACKING (per-process, for socket.join/leave mechanics) ===
const rooms = new Map(); // roomId -> Set of local socketIds
const adminSockets = new Set(); // local admin socket objects (for removeAdmin/isAdmin)
const socketWebsite = new Map(); // socketId -> websiteName (local cache)

// Redis keys local to roomManager (used only here)
const REDIS_ROOM_COUNTS = "__room_counts__";
const REDIS_SOCKET_WEBSITE = "__socket_website__";
const REDIS_ROOM_SHOW_VIEWS = "__room_show_views__";
const REDIS_ROOM_LAST_BROADCAST = "__room_last_broadcast__";
// Cluster-wide single-shot lock for the viewer-count master-switch resync.
const USERS_COUNT_RESYNC_LOCK = "__users_count_resync__";
// Pause before the resync broadcast, letting the flag change reach every
// instance first. See broadcastUsersCountMaster for why this is required.
// Sized to absorb event-loop scheduling on an instance mid-fanout, including a
// GC pause or a burst of large-room writes — it is fire-and-forget, so a longer
// wait costs nothing user-visible and buys a lot of tail coverage.
const RESYNC_PROPAGATION_DELAY_MS = 500;

// Cache
let cachedRoomData = null;

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
  const counts = await redis.hGetAll(REDIS_WEBSITE_COUNTS);
  return Object.fromEntries(
    Object.entries(counts).map(([k, v]) => [k, parseInt(v) || 0]),
  );
}

function getRoomUserCount(roomId) {
  const socketIds = rooms.get(roomId);
  return socketIds ? socketIds.size : 0;
}

async function createRoom(roomId, showViews = true) {
  const alreadyInRedis = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (alreadyInRedis) {
    return { success: false, message: "Room already exists" };
  }

  rooms.set(roomId, new Set());
  const createPipeline = redis.multi();
  createPipeline.sAdd(REDIS_ROOMS_SET, roomId);
  createPipeline.hSet(REDIS_ROOM_COUNTS, roomId, "0");
  // hSetNX, not hSet: only seed a default if no value exists yet. An admin can
  // toggle showViews OFF before the match goes live (the room doesn't exist
  // yet), and updateViewsVisibility writes "false" to this hash directly. If
  // this used hSet, room creation would clobber that "false" back to the stale
  // showViews captured at scrape-schedule time. hSetNX preserves the admin's
  // choice; the toggle path (updateViewsVisibility) still uses hSet and always wins.
  createPipeline.hSetNX(REDIS_ROOM_SHOW_VIEWS, roomId, showViews ? "true" : "false");
  await createPipeline.exec();

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
  const allSocketIds = io ? await io.in(roomId).allSockets() : new Set();
  const socketIdArray = [...allSocketIds];

  // Read website names before deleting so REDIS_WEBSITE_COUNTS can be decremented
  // correctly. hmGet returns values in the same order as the input keys.
  const websiteNames = socketIdArray.length > 0
    ? await redis.hmGet(REDIS_SOCKET_WEBSITE, socketIdArray)
    : [];
  const websiteDecrements = {};
  websiteNames.forEach((site) => {
    if (site) websiteDecrements[site] = (websiteDecrements[site] || 0) + 1;
  });

  const pipeline = redis.multi();
  socketIdArray.forEach((socketId) => {
    socketWebsite.delete(socketId);
    pipeline.hDel(REDIS_SOCKET_WEBSITE, socketId);
  });
  const websiteDecrementEntries = Object.entries(websiteDecrements);
  for (const [site, count] of websiteDecrementEntries) {
    pipeline.hIncrBy(REDIS_WEBSITE_COUNTS, site, -count);
  }
  const socketCleanupResults = await pipeline.exec();
  // Floor-clamp any WEBSITE_COUNTS that went negative (double-decrement race
  // between deleteRoom and a simultaneous leaveRoom on the same socket).
  for (let i = 0; i < websiteDecrementEntries.length; i++) {
    const [site] = websiteDecrementEntries[i];
    const webCount = parseInt(socketCleanupResults[socketIdArray.length + i]) || 0;
    if (webCount < 0) await redis.hSet(REDIS_WEBSITE_COUNTS, site, "0");
  }

  if (io) {
    io.to(roomId).emit("room_deleted", { roomId });
  }

  rooms.delete(roomId);
  // Pipeline all cleanup writes — all are independent.
  const cleanupPipeline = redis.multi();
  cleanupPipeline.sRem(REDIS_ROOMS_SET, roomId);
  cleanupPipeline.hDel(REDIS_ROOM_COUNTS, roomId);
  cleanupPipeline.hDel(REDIS_ROOM_SHOW_VIEWS, roomId);
  cleanupPipeline.hDel(REDIS_ROOM_LAST_BROADCAST, roomId);
  // Wipe pending counter-drain entries — prevents the next drain from
  // upserting (resurrecting) the room doc we just deleted.
  cleanupPipeline.hDel(REDIS_ROOM_MSG_COUNTS, roomId);
  cleanupPipeline.hDel(REDIS_ROOM_LAST_ACTIVITY, roomId);
  // Wipe read-path caches for this room.
  cleanupPipeline.del(`${REDIS_MSG_CACHE_PREFIX}${roomId}`);
  cleanupPipeline.del(`${REDIS_PINNED_MSG_PREFIX}${roomId}`);
  await cleanupPipeline.exec();

  deleteChatRoomService(roomId);

  invalidateCache();
  scheduleAdminRoomUpdate();
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
    redis.del(REDIS_ROOM_SHOW_VIEWS),
    redis.del(REDIS_ROOM_LAST_BROADCAST),
    redis.del(REDIS_SOCKET_WEBSITE),
    redis.del(REDIS_WEBSITE_COUNTS),
    // Counter-drain state — admin reset wipes everything cluster-wide.
    redis.del(REDIS_ROOM_MSG_COUNTS),
    redis.del(REDIS_ROOM_LAST_ACTIVITY),
    redis.del(REDIS_ROOM_MSG_COUNTS_DRAIN),
    redis.del(REDIS_ROOM_LAST_ACTIVITY_DRAIN),
    redis.del(DRAIN_LOCK_KEY),
  ]);

  // Wipe per-room read-path caches using the roomIds already fetched above.
  if (roomIds.length > 0) {
    await Promise.all(
      roomIds.flatMap((id) => [
        redis.del(`${REDIS_MSG_CACHE_PREFIX}${id}`),
        redis.del(`${REDIS_PINNED_MSG_PREFIX}${id}`),
      ]),
    );
  }

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
  // Step 1: parallel reads — no dependency on each other
  const [existsInRedis, showViewsValue] = await Promise.all([
    redis.sIsMember(REDIS_ROOMS_SET, roomId),
    redis.hGet(REDIS_ROOM_SHOW_VIEWS, roomId),
  ]);

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
  socket.roomId = roomId;
  if (websiteName) socket.websiteName = websiteName;

  // Step 2: pipeline writes — hSet + count + website counter in one round trip
  const joinPipeline = redis.multi();
  let countIdx = 0;
  if (websiteName) {
    socketWebsite.set(socket.id, websiteName);
    joinPipeline.hSet(REDIS_SOCKET_WEBSITE, socket.id, websiteName); // [0]
    countIdx = 1;
    if (isNewJoin) {
      joinPipeline.hIncrBy(REDIS_ROOM_COUNTS, roomId, 1);            // [1]
      joinPipeline.hIncrBy(REDIS_WEBSITE_COUNTS, websiteName, 1);    // [2]
    } else {
      joinPipeline.hGet(REDIS_ROOM_COUNTS, roomId);                  // [1]
    }
  } else {
    if (isNewJoin) {
      joinPipeline.hIncrBy(REDIS_ROOM_COUNTS, roomId, 1);            // [0]
    } else {
      joinPipeline.hGet(REDIS_ROOM_COUNTS, roomId);                  // [0]
    }
  }
  socket.join(roomId);
  const joinResults = await joinPipeline.exec();
  const count = parseInt(joinResults[countIdx]) || 0;

  scheduleAdminRoomUpdate();

  // EFFECTIVE visibility: this room's own setting AND the cluster-wide
  // viewer-count master switch. Handing the client the already-combined answer
  // is what lets join_result be self-sufficient: it learns the final visibility
  // in the same payload that releases its loading state, so nothing has to
  // correct it afterwards. update_views_visibility stays what its name says —
  // a CHANGE notification for rooms a client is already in.
  const showViews =
    showViewsValue !== "false" && !!getFlag(FEATURE_USERS_COUNT);
  return {
    success: true,
    roomId,
    showViews,
    // Costs nothing: showViewsValue is already in hand from the hGet in the
    // Step 1 Promise.all above, and the flag is an in-memory read — no extra
    // Redis command or round trip. The count is withheld whenever the counter
    // is hidden (SHOW_VIEWS_AND_BROADCAST.md Fix 2), so this carries the
    // setting, never the number.
    ...(showViews && { usersCount: count }),
  };
}

async function leaveRoom(socket) {
  const roomId = socket.roomId;
  if (!roomId) return null;

  // Clean up local state
  if (rooms.has(roomId)) {
    const socketIds = rooms.get(roomId);
    socketIds.delete(socket.id);
    if (socketIds.size === 0) rooms.delete(roomId);
  }

  // Save website name before cleanup — socket.websiteName set at join time
  const websiteName = socket.websiteName || socketWebsite.get(socket.id);
  socketWebsite.delete(socket.id);
  socket.leave(roomId);
  socket.roomId = null;

  // Step 1: pipeline hDel + sIsMember — independent operations
  const leavePipeline = redis.multi();
  leavePipeline.hDel(REDIS_SOCKET_WEBSITE, socket.id);
  leavePipeline.sIsMember(REDIS_ROOMS_SET, roomId);
  const [socketWebsiteDeleted, roomStillExists] = await leavePipeline.exec();

  // Step 2: decrements
  // socketWebsiteDeleted === 1 means leaveRoom deleted the SOCKET_WEBSITE entry itself,
  // so deleteRoom hadn't touched it yet → we are responsible for decrementing WEBSITE_COUNTS.
  // socketWebsiteDeleted === 0 means deleteRoom already deleted the entry AND already
  // decremented WEBSITE_COUNTS → skip to avoid double-decrement.
  // ROOM_COUNTS only decremented if room still exists — deleteRoom cleans it via hDel otherwise.
  let count = 0;
  const shouldDecrWebsite = websiteName && socketWebsiteDeleted === 1;
  const decrPipeline = redis.multi();
  if (roomStillExists) decrPipeline.hIncrBy(REDIS_ROOM_COUNTS, roomId, -1);
  if (shouldDecrWebsite) decrPipeline.hIncrBy(REDIS_WEBSITE_COUNTS, websiteName, -1);

  if (roomStillExists || shouldDecrWebsite) {
    const decrResults = await decrPipeline.exec();
    if (roomStillExists) {
      count = parseInt(decrResults[0]) || 0;
      if (count < 0) {
        await redis.hSet(REDIS_ROOM_COUNTS, roomId, "0");
        count = 0;
      }
    }
    if (shouldDecrWebsite) {
      const webIdx = roomStillExists ? 1 : 0;
      const webCount = parseInt(decrResults[webIdx]) || 0;
      if (webCount < 0) await redis.hSet(REDIS_WEBSITE_COUNTS, websiteName, "0");
    }
  }

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

async function updateViewsVisibility(data) {
  const roomId = data?.roomId;
  const showViews = !!data?.data?.showViews;

  await redis.hSet(REDIS_ROOM_SHOW_VIEWS, roomId, showViews ? "true" : "false");

  const io = getIO();
  if (!io) return;

  // EFFECTIVE visibility: this room's setting AND the viewer-count master
  // switch. update_views_visibility is the one channel every client already
  // obeys, so expressing the master switch through it means the switch applies
  // to whatever build is deployed, with no client change at all.
  const effective = showViews && !!getFlag(FEATURE_USERS_COUNT);

  if (effective) {
    // Count BEFORE visibility. The client may be holding no count at all (none
    // is sent while either gate is shut), and scheduleUserCountUpdate's debounce
    // would leave a 0 sitting under a freshly revealed counter for a full
    // second. Reading it here costs one hGet on an admin-only path.
    const count = parseInt(await redis.hGet(REDIS_ROOM_COUNTS, roomId)) || 0;
    io.to(roomId).emit("room_user_count_update", { roomId, usersCount: count });
    // Re-seed the dedupe hash to match what was just sent, so the next
    // scheduleUserCountUpdate doesn't repeat it.
    await redis.hSet(REDIS_ROOM_LAST_BROADCAST, roomId, count.toString());
  }

  io.to(roomId).emit("update_views_visibility", { roomId, showViews: effective });
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

async function scheduleAdminRoomUpdate() {
  // Cluster-wide throttle via Redis NX key — only one instance across all 5
  // PM2 processes fires the update per 2 s window. Other instances skip.
  // Uses same pattern as scheduleUserCountUpdate.
  const won = await redis.set("__admin_update_throttle__", "1", {
    NX: true,
    PX: 2000,
  });
  if (!won) return;

  setTimeout(async () => {
    await notifyAdminRoomUpdate();
  }, 2000);
}

async function notifyAdminRoomUpdate() {
  const io = getIO();
  if (!io) return;

  const roomData = await getCachedRoomData();
  // io.to("__admins__") reaches ALL admin sockets across all 6 processes via Redis adapter
  io.to("__admins__").emit("admin_room_update", roomData);
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

async function scheduleUserCountUpdate(roomId) {
  // Master switch off → no room renders a count, so the whole debounce +
  // broadcast path is dead weight. Checked FIRST, before the Redis NX set, so
  // a disabled counter costs zero Redis ops and zero broadcasts per join and
  // leave — the in-memory flag read is free. __room_last_broadcast__ is left
  // untouched while off; broadcastUsersCountMaster() re-seeds it on flip-on.
  if (!getFlag(FEATURE_USERS_COUNT)) return;

  const debounceMs =
    getCurrentPerformanceMode().settings.userCountUpdateDebounce;
  const debounceKey = `__user_count_debounce__:${roomId}`;

  // Only the first process to set this key within the debounce window broadcasts.
  // All other processes see the key already exists and skip — cross-process coordination.
  const won = await redis.set(debounceKey, "1", { NX: true, PX: debounceMs });
  if (!won) return;

  setTimeout(async () => {
    const io = getIO();
    if (!io) return;

    // All 4 reads are independent — one pipeline RTT instead of 3 serial groups.
    const checkPipeline = redis.multi();
    checkPipeline.sIsMember(REDIS_ROOMS_SET, roomId);       // [0]
    checkPipeline.hGet(REDIS_ROOM_SHOW_VIEWS, roomId);      // [1]
    checkPipeline.hGet(REDIS_ROOM_COUNTS, roomId);          // [2]
    checkPipeline.hGet(REDIS_ROOM_LAST_BROADCAST, roomId);  // [3]
    const [exists, showViewsValue, countRaw, lastBroadcastRaw] = await checkPipeline.exec();

    // Re-check at fire time: this timer may have been armed just before the
    // master switch was turned off, and the schedule-time guard above cannot
    // see a flip that happened during the debounce window.
    if (!getFlag(FEATURE_USERS_COUNT)) return;
    if (!exists) {
      rooms.delete(roomId);
      return;
    }
    if (showViewsValue === "false") return;
    const count = parseInt(countRaw) || 0;
    const lastBroadcast = parseInt(lastBroadcastRaw) || 0;
    if (count === lastBroadcast) return;

    io.to(roomId).emit("room_user_count_update", { roomId, usersCount: count });
    await redis.hSet(REDIS_ROOM_LAST_BROADCAST, roomId, count.toString());
  }, debounceMs);
}

// Re-sync every room after the viewer-count master switch is toggled, in BOTH
// directions. This is what actually makes the switch take effect on connected
// viewers: it drives the same update_views_visibility event the per-room Views
// checkbox uses, which every deployed client already honours.
//
// Per room the count is emitted BEFORE the visibility, so a client never sees
// the counter revealed while still holding the number from before the switch
// was turned off. On the OFF direction no count is sent — the counter is being
// hidden, and the server stops feeding the room until it comes back.
//
// io.to(roomId) fans out to every PM2 instance through the Redis adapter and
// onFlagChange fires on ALL instances (twice on the originating one), so an
// unguarded call would emit up to N+1 copies per room. The lock is keyed on the
// toggle's own seq rather than on a time window: every dispatch of the SAME
// toggle competes for one key, while a different toggle — including an
// immediate flip back — always gets its own, so rapid flipping can never skip a
// resync. "on" is the fallback key for a publish from an instance still running
// a build without seq (rolling deploy).
async function broadcastUsersCountMaster(enabled, seq) {
  const io = getIO();
  if (!io) return;

  // Pause BEFORE electing, not after. setFlag notifies its own instance
  // synchronously, ahead of the publish that reaches the others, so the worker
  // that served the admin request would otherwise always win the election and
  // then hold the key for the whole pause — if it died or was PM2-reloaded in
  // that window, every other instance had already returned and no resync would
  // ever run. Pausing first means a dead worker simply never takes the key and
  // another instance does. The pause is uniform, so the election race is
  // unchanged. It also lets the flag reach every instance before any broadcast
  // goes out, so no client is answered from a stale join_room in between.
  await new Promise((resolve) =>
    setTimeout(resolve, RESYNC_PROPAGATION_DELAY_MS),
  );

  // One executor per toggle, cluster-wide: onFlagChange fires on every instance
  // (twice on the originator) and io.to(roomId) fans out through the Redis
  // adapter, so an unguarded call would emit N+1 copies per room. Keyed on the
  // toggle's own seq, so every dispatch of the SAME toggle competes for one key
  // while a different toggle — including an immediate flip back — always gets
  // its own and can never be skipped. A seq-less publish (an instance still
  // running a build without it) falls back to an "on"/"off" direction key on a
  // short TTL; that fallback CAN swallow a second same-direction toggle inside
  // its window, which is why it exists only for the rolling-deploy case.
  const lockKey = `${USERS_COUNT_RESYNC_LOCK}:${seq ?? (enabled ? "on" : "off")}`;
  const won = await redis.set(lockKey, "1", {
    NX: true,
    PX: seq === undefined ? 2000 : 30000,
  });
  if (!won) return;

  try {
    // Re-read the flag rather than trusting the `enabled` argument, which was
    // captured before the pause. If a second toggle landed during it, the room
    // state read below is the NEW state, and pairing it with the OLD value
    // would broadcast a mismatched combination. Reading it here makes a late
    // resync converge on the truth instead; `enabled` survives only as part of
    // the lock key, which must stay tied to the toggle that scheduled this.
    const on = !!getFlag(FEATURE_USERS_COUNT);

    // Reads are bounded by room count (tens), not socket count, and this runs
    // once per admin toggle — never on the join or message path.
    const [roomIds, showViewsMap, counts] = await Promise.all([
      redis.sMembers(REDIS_ROOMS_SET),
      redis.hGetAll(REDIS_ROOM_SHOW_VIEWS),
      on ? redis.hGetAll(REDIS_ROOM_COUNTS) : Promise.resolve({}),
    ]);

    const lastBroadcast = {};
    for (const roomId of roomIds) {
      // A room that opted out individually stays hidden when the master switch
      // comes back on — the master gate can only ever subtract visibility.
      const effective = on && showViewsMap?.[roomId] !== "false";
      if (effective) {
        // Count first, so the counter is never revealed showing a stale number.
        const count = parseInt(counts?.[roomId]) || 0;
        io.to(roomId).emit("room_user_count_update", {
          roomId,
          usersCount: count,
        });
        lastBroadcast[roomId] = count.toString();
      }
      io.to(roomId).emit("update_views_visibility", { roomId, showViews: effective });
    }

    // Re-seed the dedupe hash so the next scheduleUserCountUpdate compares
    // against what clients actually just received.
    if (Object.keys(lastBroadcast).length > 0) {
      await redis.hSet(REDIS_ROOM_LAST_BROADCAST, lastBroadcast);
    }
  } catch (err) {
    // Release the key so this toggle is not permanently marked as handled —
    // a half-finished resync must not be the cluster's final word on it.
    await redis.del(lockKey).catch(() => {});
    throw err;
  }
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

      // Rebuild REDIS_WEBSITE_COUNTS from live entries — websiteEntries and
      // liveSocketIds are already in memory from the Promise.all above, so
      // no extra Redis round trip needed. Handles crash/restart drift.
      const websiteCounts = {};
      Object.entries(websiteEntries).forEach(([socketId, site]) => {
        if (liveSocketIds.has(socketId) && site) {
          websiteCounts[site] = (websiteCounts[site] || 0) + 1;
        }
      });
      const rebuildPipeline = redis.multi();
      rebuildPipeline.del(REDIS_WEBSITE_COUNTS);
      if (Object.keys(websiteCounts).length > 0) {
        rebuildPipeline.hSet(REDIS_WEBSITE_COUNTS, websiteCounts);
      }
      await rebuildPipeline.exec();
      console.log(`🔄 Website counts rebuilt: ${JSON.stringify(websiteCounts)}`);

      // Step 2: Reconcile __room_counts__ against actual live socket counts per room.
      // For each room, the source of truth is io.in(roomId).allSockets().size
      // (cross-process). If __room_counts__ disagrees, it's stale from a crash.
      const roomIds = await redis.sMembers(REDIS_ROOMS_SET);
      const storedCounts = await redis.hGetAll(REDIS_ROOM_COUNTS);

      // Parallel allSockets queries — one Redis adapter RTT group instead of N serial.
      const actualSocketCounts = await Promise.all(
        roomIds.map(async (roomId) => {
          const sockets = await io.in(roomId).allSockets();
          return { roomId, actualCount: sockets.size };
        }),
      );

      const fixPipeline = redis.multi();
      let fixedRooms = 0;
      for (const { roomId, actualCount } of actualSocketCounts) {
        const storedCount = parseInt(storedCounts[roomId]) || 0;
        if (actualCount !== storedCount) {
          fixPipeline.hSet(REDIS_ROOM_COUNTS, roomId, actualCount.toString());
          fixedRooms++;
        }
      }
      if (fixedRooms > 0) await fixPipeline.exec();

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

// Runs on EVERY instance every 2 minutes (this is live, despite what an older
// comment here claimed). Each pass costs an io.allSockets() plus one
// io.in(room).allSockets() per room across the adapter, so at N instances it is
// N× that every cycle. The startup sweep in server.js already covers the common
// case (instance crash/restart); this only catches mid-session drift. Worth
// electing a single instance for it, or dropping it, if adapter load matters.
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
  getIO,
  scheduleUserCountUpdate,
  validateCounts,
  broadcastBanToAllRooms,
  broadcastUsersCountMaster,
};
