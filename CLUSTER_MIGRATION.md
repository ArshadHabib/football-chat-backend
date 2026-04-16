# PM2 Cluster Mode Migration — Redis-Enabled

## Overview

This document covers every change made to enable PM2 cluster mode with 5 worker processes, what new infrastructure is required, and what needs to change on any client connecting to this server.

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

> **Why pool size matters:** With 5 processes each opening their own connection pool, the total MongoDB connections = `instances × MONGO_POOL_SIZE`. At the default of 10, that's 50 connections. Setting it to 5 keeps total connections at 25, which is safer for most MongoDB deployments.

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
  instances: 5,                        // 1 core reserved for Redis + MongoDB on same server
  exec_mode: "cluster",
  max_memory_restart: "800M",          // 5 × 800MB = 4GB for Node.js
  node_args: "--max-old-space-size=700" // V8 heap cap below restart threshold
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
| `deleteAllRooms()` | Used local `rooms.keys()`, returned early if empty leaving stale Redis data | Uses `redis.sMembers()`; always clears all Redis keys before early return |
| `joinRoom()` | Checked local Map, `hIncrBy` fired unconditionally | Checks Redis, guards with `isNewJoin` to prevent duplicate count inflation |
| `leaveRoom()` | Checked local Map, returned local `socketIds.size` | Decrements Redis counter (if room still exists), returns Redis count |
| `roomExists()` | `rooms.has(roomId)` — stale local fast-path bypassed Redis after cross-process deletion | Always checks Redis; cleans up stale local entry if Redis says room is gone |
| `getUsersPerRoom()` | Derived from local Map | Reads `__room_counts__` from Redis |
| `getUsersPerWebsite()` | Derived from local Map + local `socketWebsite` | Reads `__socket_website__` from Redis |
| `getTotalUsers()` | Derived from local Map | Derived from Redis room counts |
| `getCachedRoomData()` | Sync, local data | Async, fetches from Redis |
| `registerAdmin()` | `adminSockets.add(socket)` + sent local data | Also calls `socket.join("__admins__")` — a Socket.io room that works cross-process |
| `notifyAdminRoomUpdate()` | Iterated `adminSockets` Set — local only | `io.to("__admins__").emit(...)` — reaches all admins on all processes |
| `emitToAdmins()` | Iterated `adminSockets` Set — local only | `io.to("__admins__").emit(...)` — reaches all admins on all processes |
| `emitToAdmin()` | Iterated `adminSockets` to find by ID — local only | `io.to(socketId).emit(...)` — works cross-process with Redis adapter |
| `scheduleAdminRoomUpdate()` | Used `adminUpdateDebounce` from performance mode | Always fires at `0ms` — admins always get instant updates regardless of performance mode |
| `broadcastUserCountUpdates()` | `rooms.has(roomId)` — stale local fast-path | Always checks Redis; cleans up stale local entry if room is gone |
| `validateCounts()` | Sync, local | Async, reads from Redis |

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

Six issues discovered via code review and production observation after the initial Redis migration:

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

### 3. `deleteAllRooms()` — Stale socket data survives restart (P1)

**Problem:** On server restart, PM2 kills all processes abruptly. `leaveRoom()` never runs for existing connections, so `__socket_website__` retains stale `socketId → websiteName` entries. When the football-backend calls the delete-and-recreate-rooms API after restart, `deleteAllRooms()` checks `redis.sMembers(REDIS_ROOMS_SET)` — which is empty because no users have joined yet — and returns early with "No rooms to delete". The cleanup of `__socket_website__` is never reached, so stale website user counts persist on the admin dashboard.

**Example:**
```
Before restart:  __socket_website__ = { "abc123": "score8o8.com" }
Server restarts: leaveRoom() never called — Redis untouched
Football-backend calls deleteAllRooms()
  → __rooms__ is empty → returns early
  → __socket_website__ still has stale entry
Admin dashboard: score8o8.com = 1 user  ← wrong, nobody is connected
```

**Fix:** Move the Redis cleanup before the early return so it always runs regardless of room count:
```js
async function deleteAllRooms() {
  const roomIds = await redis.sMembers(REDIS_ROOMS_SET);

  // Always clear stale socket data regardless of room count
  rooms.clear();
  socketWebsite.clear();
  await Promise.all([
    redis.del(REDIS_ROOMS_SET),
    redis.del(REDIS_ROOM_COUNTS),
    redis.del(REDIS_SOCKET_WEBSITE),
  ]);

  if (roomIds.length === 0) {
    return { success: true, message: "No rooms to delete", deletedCount: 0 };
  }
  // ... rest of function
}
```

---

### 4. `broadcastUserCountUpdates()` — Stale local fast-path

**Problem:** Same class of bug as `roomExists()`. The function checked `rooms.has(roomId)` before consulting Redis. If another process deleted the room, the local Map still had a stale entry, so the function would broadcast a `room_user_count_update` event to a room that no longer existed.

```js
// Before fix — stale fast-path
const exists =
  rooms.has(roomId) ||                          // ← could return true from stale local entry
  (await redis.sIsMember(REDIS_ROOMS_SET, roomId));
```

**Fix:** Always check Redis and clean up stale local entries:
```js
const exists = await redis.sIsMember(REDIS_ROOMS_SET, roomId);
if (!exists) rooms.delete(roomId); // clean up stale local entry
```

**Impact:** Lower severity than `roomExists()` — broadcasting to a deleted room goes nowhere since all sockets already left. But it left stale entries in the local Map indefinitely and was inconsistent with the fix applied to `roomExists()`.

---

### 5. Stale `__socket_website__` AND `__room_counts__` from instance crashes (P1)

**Root cause:** When a PM2 process dies abruptly (memory limit hit, crash, force restart), all sockets on that instance disconnect without `leaveRoom()` ever running. Two Redis structures get corrupted:

| Redis Key | What gets stale | Visible symptom |
|---|---|---|
| `__socket_website__` | Orphaned `socketId → website` entries | Inflated website user counts on admin dashboard |
| `__room_counts__` | Inflated counts (`hIncrBy(+1)` from join, no matching `hIncrBy(-1)` from leave) | Inflated per-room and total user counts |

**Real-world symptom (observed):** After matches ended, admin dashboard showed:
- Total Active Chat Rooms: 0
- Total Active Users: 0
- But website counts: score8o8.com = 116, halastream.live = 14, etc.
- Redis `__socket_website__` had 150 stale entries

**Why this is independent of room lifecycle:** A crash on instance 2 corrupts both keys immediately, regardless of whether matches are running. The stale data persists until something explicitly cleans it.

**Fix:** Extend `validateCounts()` to reconcile both keys against the live socket state across all instances, and call it on every process startup.

**Step 1 — Clean `__socket_website__`:**
```js
const [liveSocketIds, websiteEntries] = await Promise.all([
  io.allSockets(),                          // cross-process via Redis adapter
  redis.hGetAll(REDIS_SOCKET_WEBSITE),
]);

const staleSocketIds = Object.keys(websiteEntries).filter(
  (socketId) => !liveSocketIds.has(socketId)
);
// delete stale entries via pipeline
```

**Step 2 — Reconcile `__room_counts__`:**
```js
const roomIds = await redis.sMembers(REDIS_ROOMS_SET);
for (const roomId of roomIds) {
  const actualSockets = await io.in(roomId).allSockets();  // cross-process
  const actualCount = actualSockets.size;
  const storedCount = parseInt(storedCounts[roomId]) || 0;

  if (actualCount !== storedCount) {
    await redis.hSet(REDIS_ROOM_COUNTS, roomId, actualCount.toString());
  }
}
```

For each room, `io.in(roomId).allSockets()` returns the actual cross-process socket count. If `__room_counts__` disagrees, it gets corrected to the actual live value.

**Step 3 — Startup sweep in `server.js`:**
```js
// After Redis adapter is set up, before server.listen()
await validateCounts();
```

Runs `validateCounts()` once when each process boots. When a crashed instance gets restarted by PM2 (~3 seconds), the new process immediately reconciles all stale entries left by the dead instance — no waiting period.

**Recovery time:**

| Event | Recovery time |
|---|---|
| Instance crash (PM2 restart) | ~3 seconds — startup sweep runs on the new process |
| Frontend reconnect (10s delay) | Count already corrected before user reconnects |
| Rolling `pm2 reload` | Each restarted instance runs a sweep on boot |

> The 2-minute periodic validation loop is currently commented out in `socket/roomManager.js`. Startup sweep handles the common case. Uncomment the `setInterval(validateCounts, 120000)` line later if mid-session drift from other causes ever becomes an issue.

**Consistency guarantee after this fix:**

| Redis Key | Survives instance crash? |
|---|---|
| `__rooms__` | Yes — only modified by API, not socket events |
| `__room_counts__` | Self-heals within ~3 seconds via startup sweep |
| `__socket_website__` | Self-heals within ~3 seconds via startup sweep |

---

#### Future optimization — `validateCounts()` performance

**Current cost at scale (100 rooms, 75,000 sockets):**

| Operation | Cost | Notes |
|---|---|---|
| `io.allSockets()` | ~500ms–2s | Cross-process pub/sub, collects 75k IDs |
| `redis.hGetAll(__socket_website__)` | ~20ms | Large hash read |
| Stale filter + pipeline delete | ~50ms | JS filtering + one Redis round trip |
| `io.in(roomId).allSockets()` in loop | **~3 seconds** | **N rooms × ~30ms each, sequential** |
| Final stats (hGetAll × 2) | ~30ms | |

**Total: ~3–5 seconds per run.**

The main bottleneck is the sequential loop in Step 2:
```js
for (const roomId of roomIds) {
  const actualSockets = await io.in(roomId).allSockets();  // awaited one at a time
  // ...
}
```
Each call is a cross-process pub/sub query. 100 rooms = 100 sequential round trips.

**Why this is acceptable today:** It only runs as a startup sweep (once per process restart). ~3s of startup delay before accepting traffic is fine.

**When to optimize:** If you uncomment the 2-minute periodic validation in `roomManager.js`, apply one of these optimizations first.

**Option A — Parallelize the loop (easy fix, ~100x speedup):**
```js
const roomChecks = await Promise.all(
  roomIds.map(async (roomId) => {
    const sockets = await io.in(roomId).allSockets();
    return { roomId, actualCount: sockets.size };
  })
);
for (const { roomId, actualCount } of roomChecks) {
  const storedCount = parseInt(storedCounts[roomId]) || 0;
  if (actualCount !== storedCount) {
    await redis.hSet(REDIS_ROOM_COUNTS, roomId, actualCount.toString());
    fixedRooms++;
  }
}
```
All 100 queries fire concurrently. Total drops from ~3s → ~50ms (one round-trip).
Trade-off: briefly puts 100 pub/sub messages through Redis at once.

**Option B — Single `io.fetchSockets()` call (most efficient):**
```js
const allSockets = await io.fetchSockets();
const actualCounts = {};
for (const sock of allSockets) {
  for (const room of sock.rooms) {
    if (room !== sock.id) {
      actualCounts[room] = (actualCounts[room] || 0) + 1;
    }
  }
}
for (const roomId of roomIds) {
  const actualCount = actualCounts[roomId] || 0;
  const storedCount = parseInt(storedCounts[roomId]) || 0;
  if (actualCount !== storedCount) {
    await redis.hSet(REDIS_ROOM_COUNTS, roomId, actualCount.toString());
    fixedRooms++;
  }
}
```
One cross-process call returns all sockets with their rooms. No loop of queries.
Trade-off: serializes full socket data over Redis pub/sub (heavier payload), but single network round trip instead of N+1.

**Recommendation:** Start with Option A when re-enabling periodic validation. Move to Option B only if the periodic run shows measurable load on Redis.

---

### 6. `modules/chat/service.js` — Removed unused static imports

`BATCH_FLUSH_INTERVAL` and `MAX_BATCH_SIZE` were imported from `perfomance_config` but never used. The code was already reading these values dynamically via `getCurrentPerformanceMode().settings.batchFlush` and `getCurrentPerformanceMode().settings.maxBatchSize`, which correctly respond to live performance mode changes without needing a restart.

```js
// Before — unused static imports
const { BATCH_FLUSH_INTERVAL, MAX_BATCH_SIZE, getCurrentPerformanceMode } = require("...");

// After — only the dynamic accessor needed
const { getCurrentPerformanceMode } = require("...");
```

**Why dynamic matters:** If you call `POST /change-server-mode` to switch to Peak mode, `getCurrentPerformanceMode().settings.batchFlush` immediately returns the new value on the next flush interval. A static constant imported at startup would never update.

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

## Before vs After — Capacity & Reliability Analysis

### Concurrent Users

| | Before | After |
|---|---|---|
| Node.js processes | 1 | 5 |
| CPU cores used | 1 of 6 | 5 of 6 |
| Per-process connection cap | 10,000 (code) | 15,000 (code) |
| OS file descriptor limit | ~1,024 (default) | 65,535 |
| Effective WebSocket ceiling | **~1,000** (OS kills at 1,024 fds) | **~75,000** (5 × 15,000) |
| Real-world comfortable limit | ~800 users | ~50,000–60,000 users |

The OS fd limit was the real wall before — not the code cap. Every WebSocket is a file descriptor. At ~1,000 connections the OS would start refusing new ones regardless of what the code said.

---

### Reliability

| | Before | After |
|---|---|---|
| WebSocket idle timeout | **60s** (nginx default killed idle connections) | **3600s** (1 hour) |
| Process crash = downtime | Yes — single process dies, everyone drops | No — 4 other processes keep serving |
| Memory growth | Unbounded (no restart threshold) | Capped at 800MB per process, auto-restart |
| Stats accuracy in cluster | N/A (single process) | Accurate cross-process via Redis |
| Room state in cluster | N/A | Shared via Redis — consistent across all 5 processes |

The nginx 60s timeout was silently disconnecting all idle users every minute. Any user watching a stream without chatting would get disconnected repeatedly.

---

### Performance

| | Before | After |
|---|---|---|
| Admin updates | Debounced by performance mode | Always instant (hardcoded 0ms) |
| `io.to(room).emit()` reach | Only sockets on same process | All sockets across all 5 processes |
| User count accuracy | Accurate (single process) | Accurate (Redis atomic counters) |
| MongoDB connections | 10 (default pool) | 25 (5 processes × 5 connections) |

---

### Summary

```
Before:  ~800–1,000 concurrent users  (OS fd wall)
After:   ~50,000–75,000 concurrent users

Improvement: ~60–75x
```

**Biggest single gains:**
1. **OS fd limit** — from 1,024 to 65,535 (unlocked the real ceiling)
2. **PM2 cluster** — 5x more CPU capacity
3. **Nginx timeout** — stopped silently killing idle connections every 60s
4. **Redis adapter** — made the cluster actually work correctly instead of 5 isolated silos

---

## Production Server Tuning (6 cores / 12GB RAM)

### Capacity Summary

| Component | Allocation |
|---|---|
| OS | ~1GB RAM |
| Redis (localhost) | ~300–500MB RAM |
| MongoDB (localhost) | ~4–6GB RAM (uses available RAM for cache) |
| 5 Node.js processes × 800MB | 4GB RAM |
| **Total** | ~9.5–11.5GB of 12GB |

**Concurrent user ceiling:** 5 processes × 15,000 hard cap = **75,000 concurrent connections**
Real-world limit is MongoDB write throughput under high message rates before that ceiling is reached.

---

### 1. Ecosystem Config (`ecosystem.config.js`)

Updated from the original — three key changes:

| Setting | Old | New | Reason |
|---|---|---|---|
| `instances` | `"max"` (6) | `5` | Leaves 1 core free for Redis + MongoDB on same server |
| `max_memory_restart` | `512M` | `800M` | More headroom per process (~15k connections before restart) |
| `node_args` | — | `--max-old-space-size=700` | V8 heap cap below restart threshold so GC runs before PM2 kills the process |

**Why `--max-old-space-size=700` with `max_memory_restart=800M`:**

Without the V8 cap, Node.js doesn't know about PM2's 800MB limit. It keeps allocating memory and only runs garbage collection when it feels like it. This causes a spike pattern:

```
Memory grows to 780MB
V8 hasn't run GC yet — still thinks it has room
Burst of requests pushes memory to 820MB
PM2 sees 820MB > 800MB → kills process
All 15,000 connections on that process drop simultaneously
```

With `--max-old-space-size=700`, V8 knows its heap limit is 700MB. It runs GC aggressively as memory approaches 700MB, freeing unused objects and recovering memory before PM2 ever sees the 800MB threshold:

```
Memory grows to 680MB
V8 sees it's approaching its 700MB heap limit
V8 runs GC → frees unused objects → drops back to ~500MB
PM2 never sees 800MB → no restart → no dropped connections
```

The 100MB gap between the V8 cap (700MB) and the PM2 restart threshold (800MB) is the safety buffer that lets GC do its job.

---

### 2. Connection Limit (`socket/socketHandler.js`)

Raised from 10,000 to 15,000 per process:

```js
// Connection limits — remove this block to let max_memory_restart in ecosystem.config.js act as the only safety net
if (io.engine.clientsCount > 15000) {
  socket.emit("error", { message: "Server at capacity" });
  socket.disconnect();
  return;
}
```

**Why keep this limit:** Fails new connections gracefully with an error message. Without it, the failure mode is a hard PM2 memory restart that drops all existing connections simultaneously.

---

### 3. Nginx Config

Two bugs fixed from original config:
- `proxy_read_timeout` defaulted to 60s — nginx silently killed idle WebSocket connections after 1 minute
- `Connection 'upgrade'` was hardcoded — broke regular HTTP API requests

Nginx uses two separate files. Changes go into both.

---

#### File 1: `/etc/nginx/nginx.conf` — global worker and http settings

Add/update the top-level worker settings and the WebSocket upgrade map inside the `http` block.

**Open in editor:**
```bash
sudo nano /etc/nginx/nginx.conf
```

Make sure these values are set:
```nginx
user www-data;
worker_processes auto;                  # uses all 6 cores
worker_rlimit_nofile 65535;             # file descriptors per nginx worker

events {
    worker_connections 16384;           # 6 workers × 16384 = ~98k total nginx connections
    use epoll;
    multi_accept on;
}

http {
    # Add this map inside the http block — enables correct WebSocket + HTTP handling
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    # ... rest of your existing http block (include, gzip, etc.)
}
```

---

#### File 2: `/etc/nginx/sites-available/chat.halastream.app` — domain config

**Open in editor:**
```bash
sudo nano /etc/nginx/sites-available/chat.halastream.app
```

Replace the contents with:
```nginx
upstream app_chat_backend {
    server 127.0.0.1:5002;
    keepalive 512;                      # idle keepalive connections to Node.js (was 64)
}

server {
    listen 80;
    server_name chat.halastream.app;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name chat.halastream.app;

    ssl_certificate     /etc/letsencrypt/live/chat.halastream.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.halastream.app/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://app_chat_backend;
        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;  # uses map from nginx.conf, not hardcoded
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;       # 1 hour — prevents nginx killing idle WebSockets
        proxy_send_timeout 3600s;
        proxy_connect_timeout 60s;

        proxy_buffering off;            # required for real-time Socket.io events
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

#### Apply changes:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

### 4. OS File Descriptor Limits

Without this, the OS hard-kills connections at 1,024 file descriptors per process regardless of your Node.js or nginx config.

**Option A — single command (paste and run):**
```bash
sudo tee -a /etc/security/limits.conf <<EOF
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF
```

**Option B — open in editor:**
```bash
sudo nano /etc/security/limits.conf
```
Add at the bottom:
```
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
```

Reboot or re-login for limits to take effect. Verify after:
```bash
ulimit -n
# Expected: 65535
```

---

### 5. Kernel TCP Tuning

**Option A — single command (paste and run):**
```bash
sudo tee -a /etc/sysctl.conf <<EOF
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 3
net.ipv4.ip_local_port_range = 1024 65535
EOF
```

**Option B — open in editor:**
```bash
sudo nano /etc/sysctl.conf
```
Add at the bottom:
```
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 3
net.ipv4.ip_local_port_range = 1024 65535
```

Apply immediately (no reboot needed):
```bash
sudo sysctl -p
```

| Setting | Purpose |
|---|---|
| `somaxconn` | Max connection queue depth — prevents dropped connections under burst load |
| `tcp_max_syn_backlog` | Max half-open connections during TLS/TCP handshake |
| `tcp_fin_timeout` | Free sockets faster after disconnect (default 60s → 30s) |
| `tcp_keepalive_time` | Detect dead connections after 5 min instead of 2 hours |
| `ip_local_port_range` | More outbound ports available for proxied connections |

---

### 6. Inspecting Redis State

**Interactive CLI:**
```bash
redis-cli
```

Then run these to inspect live chat data:
```bash
# All active rooms
SMEMBERS __rooms__

# User count per room
HGETALL __room_counts__

# Socket → website mapping
HGETALL __socket_website__

# Total number of tracked sockets
HLEN __socket_website__
```

**One-liners (no interactive mode):**
```bash
redis-cli SMEMBERS __rooms__
redis-cli HGETALL __room_counts__
redis-cli HGETALL __socket_website__
```

**Quick health check:**
```bash
redis-cli INFO stats | grep -E "connected_clients|used_memory_human|total_commands_processed"
```

**GUI — RedisInsight (visual browser):**

1. Download and install RedisInsight from [redis.io/redis-enterprise/redis-insight](https://redis.io/redis-enterprise/redis-insight/)
2. Open an SSH tunnel on your local machine (keep the terminal open):
```bash
ssh -L 6379:127.0.0.1:6379 root@161.97.69.15
```
If port 6379 is already in use locally (e.g. local Redis running), use a different local port:
```bash
ssh -L 6380:127.0.0.1:6379 root@161.97.69.15
```
Then use port `6380` in RedisInsight instead of `6379`.
3. In RedisInsight click **Add Redis Database** and fill in the fields:

   | Field | Value |
   |---|---|
   | Host | `127.0.0.1` |
   | Port | `6379` (or `6380` if using the alternate tunnel) |
   | Database Alias | `chat-backend` |
   | Username | leave empty |
   | Password | leave empty |

4. Click **Add Redis Database** to save.
5. Click the database to open it → go to the **Browser** tab.
6. In the search/filter box search for each key:
   - `__rooms__` — shows all active room IDs (type: Set)
   - `__room_counts__` — shows user count per room (type: Hash)
   - `__socket_website__` — shows socketId → website mapping (type: Hash)

**Troubleshooting — if RedisInsight cannot connect:**
- Make sure the SSH tunnel terminal is still open (do not close it)
- In a separate terminal on your Mac, test the tunnel:
  ```bash
  redis-cli -p 6380 ping
  # Expected: PONG
  ```
- If `PONG` is not returned, Redis may not be running on the server:
  ```bash
  # Check status (run on the server)
  sudo systemctl status redis-server

  # Start if not running
  sudo systemctl start redis-server
  ```

> If your SSH user is not `root`, replace `root@161.97.69.15` with your actual username e.g. `ubuntu@161.97.69.15`

---

### 7. MongoDB Connection Pool

With `MONGO_POOL_SIZE=5` and 5 processes:

```
5 processes × 5 connections = 25 total MongoDB connections
```

If your MongoDB instance supports more connections, you can increase `MONGO_POOL_SIZE` in `.env`. Max safe value depends on your MongoDB plan/server.

---

### 8. Full Deployment Checklist

```bash
# 1. Apply OS limits
sudo tee -a /etc/security/limits.conf <<EOF
* soft nofile 65535
* hard nofile 65535
root soft nofile 65535
root hard nofile 65535
EOF

# 2. Apply kernel TCP tuning
sudo tee -a /etc/sysctl.conf <<EOF
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.core.netdev_max_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 60
net.ipv4.tcp_keepalive_probes = 3
net.ipv4.ip_local_port_range = 1024 65535
EOF
sudo sysctl -p

# 3. Update nginx configs
sudo nano /etc/nginx/nginx.conf                                    # add worker settings + map block
sudo nano /etc/nginx/sites-available/chat.halastream.app           # replace domain config
sudo nginx -t                                                       # test config
sudo systemctl reload nginx

# 4. Start Redis
sudo systemctl start redis-server
sudo systemctl enable redis-server

# 5. Start app with PM2
pm2 start ecosystem.config.js --env production
pm2 save                              # persist across reboots
pm2 startup                           # auto-start PM2 on boot (follow the printed command)

# 6. Verify
pm2 monit                             # watch memory and CPU per process
redis-cli ping                        # should return PONG
ulimit -n                             # should return 65535
```
