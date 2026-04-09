# PM2 Cluster Mode Migration — Redis-Enabled

## Overview

This document covers every change made to enable PM2 cluster mode with 6 worker processes, what new infrastructure is required, and what needs to change on any client connecting to this server.

---

## Why This Was Needed

PM2 cluster mode spawns multiple independent Node.js processes. Each process has its own isolated memory. Without Redis:

- Room state (`rooms` Map) was per-process — a room created on Process 1 was invisible to Process 2
- Admin sockets (`adminSockets` Set) were per-process — admin connected to Process 3 received zero updates from events on Process 1 or 2
- `io.to(roomId).emit()` only reached sockets on the same process
- User counts were wrong — each process reported only its own local users

Redis solves this by providing shared state and by acting as the message broker for Socket.io events across all processes.

---

## New Infrastructure Required

### Redis

Redis must be running before starting the server.

**macOS (local development):**
```bash
brew install redis
brew services start redis
```

**Ubuntu/Debian:**
```bash
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

**Verify Redis is running:**
```bash
redis-cli ping
# Expected output: PONG
```

**Production:** Use a managed Redis service (AWS ElastiCache, Redis Cloud, etc.) and set the `REDIS_URL` env variable accordingly.

---

## New Environment Variables

Add these to your `.env` file:

```env
REDIS_URL=redis://127.0.0.1:6379
MONGO_POOL_SIZE=5
MONGO_MIN_POOL_SIZE=1
```

| Variable | Purpose | Default if omitted |
|---|---|---|
| `REDIS_URL` | Redis connection string | `redis://127.0.0.1:6379` |
| `MONGO_POOL_SIZE` | Max MongoDB connections per process | `10` |
| `MONGO_MIN_POOL_SIZE` | Min MongoDB connections per process | `2` |

> **Why pool size matters:** With 6 processes each opening their own connection pool, the total MongoDB connections = `instances × MONGO_POOL_SIZE`. At the default of 10, that's 60 connections. Setting it to 5 keeps total connections at 30, which is safer for most MongoDB deployments.

---

## New Packages Installed

```bash
npm install @socket.io/redis-adapter redis
```

| Package | Purpose |
|---|---|
| `@socket.io/redis-adapter` | Makes Socket.io events propagate across all 6 processes via Redis pub/sub |
| `redis` | Redis client for shared state (room registry, counters, website tracking) |

---

## Files Changed

### New Files

#### `config/redis.js`
Three Redis client instances — each dedicated to a specific role:
- `pubClient` — general publishing and all Redis data operations (`hSet`, `hIncrBy`, `sAdd`, etc.)
- `subClient` — exclusively used by the Socket.io adapter for its internal pub/sub channels
- `perfSubClient` — exclusively used to receive performance mode change broadcasts

Separating `subClient` and `perfSubClient` is required — a Redis client in subscriber mode cannot issue regular commands, so they must not be shared.

#### `ecosystem.config.js`
PM2 configuration:
```js
{
  name: "chat-backend",
  script: "./server.js",
  instances: "max",       // uses all available CPU cores
  exec_mode: "cluster",
  max_memory_restart: "512M"
}
```

---

### Modified Files

#### `server.js`
Three changes:

1. **Redis adapter mounted on Socket.io instance** — makes all `io.to(x).emit()` calls propagate to sockets on all processes, not just the current one.

2. **`transports: ["websocket"]` added** — Socket.io's default handshake uses HTTP long-polling first, then upgrades to WebSocket. With PM2 round-robin load balancing, the polling requests for a single client can land on different processes, breaking the upgrade. Forcing WebSocket-only skips polling entirely and connects directly.

3. **Performance mode subscription** — `perfSubClient` subscribes to the `__perf_mode__` Redis channel. When any process calls `POST /change-server-mode`, it broadcasts the new mode to all other processes so they all update simultaneously.

---

#### `socket/roomManager.js`
The biggest change. All in-memory state that needs to be shared across processes now lives in Redis.

**Redis data structures used:**

| Redis Key | Type | Contains |
|---|---|---|
| `__rooms__` | Set | All active room IDs |
| `__room_counts__` | Hash | `roomId → user count` |
| `__socket_website__` | Hash | `socketId → websiteName` |

**Function changes:**

| Function | Before | After |
|---|---|---|
| `createRoom()` | Checked local `rooms` Map | Checks Redis Set |
| `deleteRoom()` | Checked local `rooms` Map | Checks Redis Set, cleans up Redis keys |
| `deleteAllRooms()` | Used local `rooms.keys()` | Uses `redis.sMembers()` for cross-process room list |
| `joinRoom()` | Checked local Map, returned local `socketIds.size` | Checks Redis, increments Redis counter, returns Redis count |
| `leaveRoom()` | Checked local Map, returned local `socketIds.size` | Decrements Redis counter (if room still exists), returns Redis count |
| `roomExists()` | `rooms.has(roomId)` — local only | Redis lookup with local fast-path |
| `getUsersPerRoom()` | Derived from local Map | Reads `__room_counts__` from Redis |
| `getUsersPerWebsite()` | Derived from local Map + local `socketWebsite` | Reads `__socket_website__` from Redis |
| `getTotalUsers()` | Derived from local Map | Derived from Redis room counts |
| `getCachedRoomData()` | Sync, local data | Async, fetches from Redis |
| `registerAdmin()` | `adminSockets.add(socket)` + sent local data | Also calls `socket.join("__admins__")` — a Socket.io room that works cross-process |
| `notifyAdminRoomUpdate()` | Iterated `adminSockets` Set — local only | `io.to("__admins__").emit(...)` — reaches all admins on all processes |
| `emitToAdmins()` | Iterated `adminSockets` Set — local only | `io.to("__admins__").emit(...)` — reaches all admins on all processes |
| `emitToAdmin()` | Iterated `adminSockets` to find by ID — local only | `io.to(socketId).emit(...)` — works cross-process with Redis adapter |
| `scheduleAdminRoomUpdate()` | Used `adminUpdateDebounce` from performance mode | Always fires at `0ms` — admins always get instant updates regardless of performance mode |
| `broadcastUserCountUpdates()` | `rooms.has(roomId)` — local only | Falls back to Redis check for cross-process rooms |
| `validateCounts()` | Sync, local | Async, reads from Redis |
| `roomExists()` | Fast-path `rooms.has(roomId)` returned stale `true` after cross-process deletion | Always checks Redis; cleans up stale local entry if Redis says room is gone |
| `joinRoom()` | `hIncrBy` fired unconditionally, inflating count on duplicate `join_room` events | Guards with `isNewJoin = !socketIds.has(socket.id)`; only increments Redis for genuinely new joins |

---

#### `socket/socketHandler.js`
No logic changes. All event handlers that call async `roomManager` functions were updated to `async`/`await`:

- `admin_authenticate` — `await registerAdmin(socket)`
- `admin_join_room` — `async`, `await getUsersPerRoom()`
- `admin_room_message` — `async`, `await roomExists()`
- `update_user` — `async`, `await roomExists()`
- `join_room` — `async`, `await joinRoom()`
- `room_message` — `await roomExists()`
- `update_views_visibility` — `async`, `await roomExists()`
- `disconnect` — `async`, `await leaveRoom()`
- `admin_request_data` — `async`, `await notifyAdminRoomUpdate()`

All event names, response shapes, and guard conditions are identical to before.

---

#### `modules/chat/controller.js`
`changeServerModeController` now publishes the new mode to the Redis `__perf_mode__` channel after setting it locally, so all 6 processes update simultaneously:

```js
setPerformanceMode(mode);
await pubClient.publish("__perf_mode__", mode);
```

---

#### `modules/chat/socket_service.js`
Added missing `await` on `createRoom()` call inside `createSocketRoomsForMatchService()`. This was a pre-existing bug — without `await`, room creation errors were silently swallowed.

---

## Post-Migration Bug Fixes

Two bugs discovered via code review after the initial Redis migration:

### 1. `roomExists()` — Stale local fast-path (P1)

**Problem:** The original fast-path `if (rooms.has(roomId)) return true` bypassed Redis entirely. When Process 1 deleted a room, `rooms.delete(roomId)` only cleared the local Map on Process 1. Processes 2–6 still had that `roomId` in their local Maps (warmed when users joined). So on those processes, `roomExists()` returned `true` without ever checking Redis — allowing `room_message` and `admin_room_message` to proceed for a room that no longer existed.

**Fix:** Always check Redis as the source of truth. If Redis says the room is gone but the local Map has a stale entry, clean it up:
```js
async function roomExists(roomId) {
  const exists = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
  if (!exists && rooms.has(roomId)) {
    rooms.delete(roomId); // clean up stale local cache entry
  }
  return exists;
}
```

---

### 2. `joinRoom()` — Duplicate join count inflation (P1)

**Problem:** `socketIds.add(socket.id)` on a JavaScript `Set` is idempotent — silently ignores duplicates. But `redis.hIncrBy(REDIS_ROOM_COUNTS, roomId, 1)` always fired unconditionally. So if the same socket sent `join_room` twice (network blip, frontend reconnect logic bug, etc.), the local Set stayed at size 1 but Redis incremented to 2. The count then stuck at 1 after disconnect instead of returning to 0.

**Example:**
```
join_room × 2  →  Redis count = 2  (should be 1)
disconnect     →  Redis count = 1  (should be 0) — stuck forever
```

**Fix:** Check if the socket is genuinely new before incrementing:
```js
const isNewJoin = !socketIds.has(socket.id);
socketIds.add(socket.id);
// ...
let count;
if (isNewJoin) {
  count = await redis.hIncrBy(REDIS_ROOM_COUNTS, roomId, 1);
} else {
  count = parseInt(await redis.hGet(REDIS_ROOM_COUNTS, roomId)) || 0;
}
```

---

## What Did NOT Change

| Component | Status |
|---|---|
| All HTTP API routes and URLs | Unchanged |
| All request body shapes | Unchanged |
| All response shapes | Unchanged |
| All Socket.io event names | Unchanged |
| All Socket.io event payloads | Unchanged |
| JWT authentication flow | Unchanged |
| Admin key authentication | Unchanged |
| Message batching and flush logic | Unchanged |
| MongoDB models and schemas | Unchanged |
| CORS configuration | Unchanged |
| Performance mode levels (normal/peak/extreme) | Unchanged |

---

## Performance Mode Behaviour After Changes

| Setting | Still controlled by performance mode | Notes |
|---|---|---|
| `adminUpdateDebounce` | **No** | Hardcoded to `0ms` — admins always get instant updates |
| `cacheTTL` | Yes | Affects non-admin room data freshness |
| `userCountUpdateDebounce` | Yes | Debounce on `room_user_count_update` events to users |
| `batchFlush` | Yes | How often messages are flushed from memory to MongoDB |
| `maxBatchSize` | Yes | Max messages batched before forced flush |
| `batchProcessing` | Yes | Admin event queue processing interval |

When `POST /change-server-mode` is called, all 6 processes update simultaneously via Redis pub/sub.

---

## How to Run

### Start Redis
```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis-server
```

### Start with PM2 (production)
```bash
pm2 start ecosystem.config.js --env production

# Monitor
pm2 monit

# View logs
pm2 logs chat-backend

# Stop
pm2 stop chat-backend
```

### Start normally (development/single process)
```bash
npm start
# or
npm run dev
```

---

## Frontend Changes Required

### Socket.io Connection — REQUIRED

The server now only accepts WebSocket connections (no HTTP polling fallback). Every frontend must add `transports: ["websocket"]` to the Socket.io connection config.

**Before:**
```js
const socket = io("http://your-server-url");
```

**After:**
```js
const socket = io("http://your-server-url", {
  transports: ["websocket"],
});
```

**Why:** Without this, the Socket.io client tries HTTP long-polling first. The server now rejects polling requests, so the connection fails before it can upgrade to WebSocket. All modern browsers support WebSocket natively.

---

### Everything Else — No Changes Needed

| Frontend concern | Change needed |
|---|---|
| Socket.io connection config | `transports: ["websocket"]` — **required** |
| Event listeners (`room_message`, `join_result`, `admin_room_update`, etc.) | None |
| Event emitters (`join_room`, `room_message`, `admin_authenticate`, etc.) | None |
| HTTP API calls | None |
| Auth token handling | None |
| Admin dashboard | None |
| Data shapes received from server | None |

---

## MongoDB Connection Pool

With `MONGO_POOL_SIZE=5` and 6 processes:

```
6 processes × 5 connections = 30 total MongoDB connections
```

If your MongoDB instance supports more connections, you can increase `MONGO_POOL_SIZE` in `.env`. Max safe value depends on your MongoDB plan/server.
