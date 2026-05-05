# Read-Path & Ban-Check Optimisation Plan

## Context

5 PM2 instances, Redis adapter for Socket.io, MongoDB for persistence. A Champions League final brings ~20K users simultaneously opening the stream page. Every user:

1. Loads the last 200 chat messages via `GET /get-room-messages`.
2. Connects via WebSocket (`join_room`).
3. If they have a saved username, fires `POST /is-user-banned`.
4. If they have no username and want to register, fires `POST /register-user`.

None of the read paths have any caching today. Everything hits MongoDB every time.

---

## Problem Analysis

### P1 — Critical: Message history thundering herd (20K × MongoDB queries)

`retrieveRoomMessagesService` always issues two MongoDB queries:

```
MessageModel.find({ roomId, timestamp: { $lt: before } }).sort({ timestamp: -1 }).limit(200).lean()
MessageModel.find({ roomId, isPinned: true }).sort({ timestamp: -1 }).limit(1).lean()
```

For the same room, both queries return identical data for every user. At 20K simultaneous page loads:

- 20K messages queries → 20K MongoDB round trips
- 20K pinned-message queries → 20K MongoDB round trips
- **40K total MongoDB queries in a burst against the same handful of documents**

The compound index `{ roomId: 1, timestamp: -1 }` and `{ roomId: 1, isPinned: 1 }` make each query fast individually (~1–5ms), but MongoDB still serialises document reads under concurrent load. The Mongoose connection pool (typically 5–10 connections per PM2 instance = 25–50 total) becomes the bottleneck — requests queue behind the pool.

Client-side: `fetchChatMessages({ cache: "no-store" }, roomId)` explicitly disables every level of HTTP caching. No nginx, no CDN, no browser cache can absorb any repeat requests.

---

### P2 — Critical: `BANNED_USERS_KEY` is cold after any Redis restart

`isUserBannedController` checks `redis.sIsMember(BANNED_USERS_KEY, name)` first. `BANNED_USERS_KEY` is a Redis Set that is only populated when an admin bans a user via `POST /update-user`. If Redis restarts (deploy, crash, failover), the Set is empty.

Consequence: every `sIsMember` returns false → falls through to `userService.findUserByName(name)` → MongoDB query. During the burst of 20K connects after a Redis restart, all `isUserBanned` calls hit MongoDB.

The same cold-start problem applies to ban enforcement in the `room_message` socket handler, which calls `redis.sIsMember(BANNED_USERS_KEY, senderName)` — banned users are effectively un-banned until an admin action re-populates the Set.

---

### P3 — High: `isUserBanned` always queries MongoDB for non-banned users

Even with a warm Redis, `isUserBannedController` only short-circuits when the user IS in `BANNED_USERS_KEY`. Non-banned users (the vast majority) fall through to:

```javascript
const user = await userService.findUserByName(name);
```

This is a MongoDB lookup on every single ban check. For 20K users where even 30% have saved usernames, that is ~6K MongoDB queries on connect — for a check whose correct answer is "not banned."

The fix is to trust Redis completely: `BANNED_USERS_KEY` is maintained synchronously on every ban/unban action. If a name is not in the Set, it is not banned. No MongoDB read needed.

---

### P4 — High: Registration IP ban check has no Redis equivalent

`registerUserController` calls `userService.findBannedUserByIp(ip)` which always queries MongoDB:

```javascript
User.findOne({ ipAddress, isBanned: true })
```

This has a compound index (`{ ipAddress: 1, isBanned: 1 }`) so each call is efficient, but there is no Redis equivalent for banned IPs — only `BANNED_USERS_KEY` tracks banned usernames. During high registration traffic (thousands of users picking usernames for the first time), every attempt hits MongoDB for the IP ban check.

---

### P5 — Medium: Pinned message is a separate MongoDB round trip on every request

Even when messages are cached (after P1 is fixed), the pinned message query is a second MongoDB call. It uses `{ roomId: 1, isPinned: 1 }` compound index so it is fast, but 20K extra round trips still adds up. Pinned messages change rarely (admin action only). A short-TTL Redis cache eliminates this entirely.

---

### P6 — Medium: `ipify.org` as single point of failure with no timeout

`fetchClientIp()` in the frontend calls `https://api.ipify.org?format=json` with no timeout and no fallback:

```typescript
const response = await fetch("https://api.ipify.org?format=json", { method: "GET" });
```

If ipify is slow or rate-limits under high concurrent registration load, every `registerChatUser` call hangs until the browser's default timeout (~30s). Silent failure already returns `""` which means the user registers without an IP — bypassing IP-based bans.

---

### P7 — Medium: React messages array grows without bound

`setMessages((prev) => [...prev, newMsg])` has no upper limit. `STORE_MESSAGES_LIMIT = 100` is defined but commented out. For a 3-hour match at ~200 msg/min, the React state array grows to ~36K entries. Each `setMessages` call re-renders with an ever-larger array, causing increasing jank as the match progresses.

---

### P8 — Low: `flushReactionBatch` still uses `setInterval` (pre-existing latent bug)

```javascript
setInterval(flushReactionBatch, getCurrentPerformanceMode().settings.batchFlush);
```

This evaluates `batchFlush` once at module load and locks in the interval forever — the same bug fixed for `flushMessageBatch` in the batch-flush plan. When admin changes performance mode, the reaction flush cadence does not update.

---

## Solution Overview


| Problem                                    | Fix                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| P1 — Thundering herd on messages           | Redis Sorted Set per room maintained on every message save; per-instance in-flight coalescing on cache miss |
| P2 — `BANNED_USERS_KEY` cold after restart | Startup warm-up loads all banned usernames and IPs from MongoDB into Redis                                  |
| P3 — `isUserBanned` MongoDB fallback       | Trust Redis as source of truth; remove `findUserByName` fallback entirely                                   |
| P4 — IP ban check hits MongoDB             | Maintain `BANNED_IPS_KEY` Redis Set; check it in registration before MongoDB                                |
| P5 — Pinned message extra round trip       | Short-TTL Redis string cache per room                                                                       |
| P6 — `ipify.org` reliability               | Add `AbortController` 5s timeout + two fallback IP services                                                 |
| P7 — Unbounded messages array              | Re-enable `STORE_MESSAGES_LIMIT` (300) on all live `setMessages` appends                                    |
| P8 — `flushReactionBatch` setInterval      | Replace with mode-aware self-rescheduling `setTimeout` loop                                                 |


---

## Implementation

### New Redis Keys

All defined in `utils/const_config.js`.


| Key                           | Type                              | Purpose                                                        |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `__room_msg_cache__:{roomId}` | Sorted Set (score = timestamp ms) | Recent 200 messages per room — maintained by write path        |
| `__room_pinned__:{roomId}`    | String (JSON or `"null"`)         | Cached pinned message — TTL 30s                                |
| `__banned_ips__`              | Set                               | Banned IP addresses — mirrors MongoDB `isBanned: true` records |


Constants to add:

```javascript
const REDIS_MSG_CACHE_PREFIX = "__room_msg_cache__:";
const REDIS_PINNED_MSG_PREFIX = "__room_pinned__:";
const BANNED_IPS_KEY = "__banned_ips__";
const MSG_CACHE_LIMIT = 200;
const PINNED_MSG_CACHE_TTL = 30; // seconds
```

---

### Change 1 — Message cache: write path (`modules/chat/service.js`)

Add a Redis Sorted Set write inside `saveChatMessageService`, immediately after the message object is constructed. This keeps the cache always current — new users loading history see messages even before the batch flush writes them to MongoDB.

```javascript
async function saveChatMessageService(roomId, messageData) {
  const message = {
    _id: new mongoose.Types.ObjectId(),
    roomId,
    ...messageData,
    timestamp: new Date(),
  };

  // Update the per-room sorted set cache immediately so history loads always
  // reflect the latest messages without waiting for a flush cycle.
  const cacheKey = `${REDIS_MSG_CACHE_PREFIX}${roomId}`;
  const pipeline = redis.multi();
  pipeline.zAdd(cacheKey, {
    score: message.timestamp.getTime(),
    value: JSON.stringify(message),
  });
  // Keep only the most recent MSG_CACHE_LIMIT entries (oldest removed by rank)
  pipeline.zRemRangeByRank(cacheKey, 0, -(MSG_CACHE_LIMIT + 1));
  // If this is a pinned message, update the pinned cache immediately so new users
  // loading history see it right away — do not wait for the 30s TTL to expire.
  if (message.isPinned) {
    pipeline.set(
      `${REDIS_PINNED_MSG_PREFIX}${roomId}`,
      JSON.stringify(message),
      { EX: PINNED_MSG_CACHE_TTL }
    );
  }
  await pipeline.exec().catch((err) => console.error("Cache write error:", err));

  if (!messageBatch.has(roomId)) {
    messageBatch.set(roomId, []);
  }
  const batch = messageBatch.get(roomId);
  batch.push(message);

  if (batch.length >= getCurrentPerformanceMode().settings.maxBatchSize) {
    await flushMessageBatch();
  }

  return true;
}
```

The ZADD + ZREMRANGEBYRANK pipeline is a single Redis round trip (~0.5ms loopback). If Redis is temporarily unavailable the `.catch` swallows the error; the batch flush path continues normally and the cache re-warms from MongoDB on the next miss.

---

### Change 2 — Message cache: read path with per-instance coalescing (`modules/chat/service.js`)

Replace the MongoDB-first read in `retrieveRoomMessagesService` with a Redis-first read. On cache miss, use a per-instance in-flight Map so that thousands of simultaneous misses on the same instance share a single MongoDB query.

```javascript
// Per-instance coalescing map: roomId → Promise<messages[]>
// If 4,000 requests arrive on one instance simultaneously and all miss the cache,
// only one MongoDB query fires; the other 3,999 await the same promise.
const cachePopulationInFlight = new Map();

async function getRecentMessagesWithCache(roomId, limit) {
  const cacheKey = `${REDIS_MSG_CACHE_PREFIX}${roomId}`;

  // Fast path — sorted set hit
  const cached = await redis.zRange(cacheKey, 0, -1);
  if (cached.length > 0) {
    return cached.map((s) => JSON.parse(s));
  }

  // Cache miss — coalesce concurrent misses on this instance into one DB query
  if (cachePopulationInFlight.has(roomId)) {
    return await cachePopulationInFlight.get(roomId);
  }

  const populatePromise = (async () => {
    const messages = await MessageModel.find({ roomId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    if (messages.length > 0) {
      const pipeline = redis.multi();
      for (const msg of messages) {
        pipeline.zAdd(cacheKey, {
          score: new Date(msg.timestamp).getTime(),
          value: JSON.stringify(msg),
        });
      }
      pipeline.zRemRangeByRank(cacheKey, 0, -(MSG_CACHE_LIMIT + 1));
      await pipeline.exec().catch((err) =>
        console.error("Cache seed error:", err),
      );
    }

    return messages.reverse(); // chronological order
  })();

  // Register before awaiting so concurrent callers see it immediately
  cachePopulationInFlight.set(roomId, populatePromise);
  populatePromise.finally(() => cachePopulationInFlight.delete(roomId));

  return await populatePromise;
}

async function retrieveRoomMessagesService(roomId, noLimit, options = {}) {
  try {
    const { limit = 200, skip = 0, before = new Date() } = options;

    if (noLimit) {
      // Admin/bulk path — bypass cache, always fresh from MongoDB
      const messages = await MessageModel.find({ roomId })
        .sort({ timestamp: -1 })
        .limit(MAX_ROOM_MESSAGES_LIMIT)
        .lean();
      return { messages: messages?.reverse(), pinnedMessage: null };
    }

    // Standard user path — Redis first
    const messages = await getRecentMessagesWithCache(roomId, limit);

    // Pinned message — short-TTL Redis cache
    let pinnedMessage = null;
    const pinnedKey = `${REDIS_PINNED_MSG_PREFIX}${roomId}`;
    const cachedPinned = await redis.get(pinnedKey);

    if (cachedPinned !== null) {
      pinnedMessage = cachedPinned === "null" ? null : JSON.parse(cachedPinned);
    } else {
      const pinnedResult = await MessageModel.find({ roomId, isPinned: true })
        .sort({ timestamp: -1 })
        .limit(1)
        .lean();
      pinnedMessage = pinnedResult?.[0] ?? null;
      await redis
        .set(pinnedKey, JSON.stringify(pinnedMessage ?? null), {
          EX: PINNED_MSG_CACHE_TTL,
        })
        .catch(() => {});
    }

    console.log(`Retrieved ${messages.length} messages from room: ${roomId}`);
    return { messages, pinnedMessage };
  } catch (error) {
    console.error(
      `Error retrieving messages from room ${roomId}:`,
      error.message,
    );
    return [];
  }
}
```

**Thundering herd reduction — 20K simultaneous connects, same room:**


| Layer                         | Before      | After                                                 |
| ----------------------------- | ----------- | ----------------------------------------------------- |
| Server — Redis                | No cache    | Sorted set hit: ~0.5ms, 0 MongoDB queries             |
| Server — MongoDB (Redis warm) | 20K queries | 0 queries                                             |
| Server — MongoDB (Redis cold) | 20K queries | 5 queries (1 per PM2 instance, coalesced within each) |


Worst case (Redis just restarted): 5 PM2 instances each get ~4K simultaneous requests. Each instance fires 1 MongoDB query thanks to `cachePopulationInFlight`. Total: **5 MongoDB queries instead of 20,000**.

---

### Change 3 — Ban cache warm-up on startup

Add a new file `modules/user/warmup.js` that seeds both ban Sets from MongoDB. Called once after the Redis connection is established, before traffic is accepted.

```javascript
// modules/user/warmup.js
const { pubClient: redis } = require("@project/config/redis");
const {
  BANNED_USERS_KEY,
  BANNED_IPS_KEY,
} = require("@project/utils/const_config");
const User = require("@project/modules/user/model");

async function warmBanCaches() {
  const bannedUsers = await User.find({ isBanned: true })
    .select("name ipAddress")
    .lean();

  if (bannedUsers.length === 0) {
    console.log("Ban cache warm-up: no banned users");
    return;
  }

  const names = bannedUsers.map((u) => u.name);
  const ips = [
    ...new Set(bannedUsers.map((u) => u.ipAddress).filter(Boolean)),
  ];

  const pipeline = redis.multi();
  pipeline.sAdd(BANNED_USERS_KEY, names);
  if (ips.length > 0) pipeline.sAdd(BANNED_IPS_KEY, ips);
  await pipeline.exec();

  console.log(
    `Ban cache warm-up: ${names.length} usernames, ${ips.length} IPs loaded into Redis`,
  );
}

module.exports = { warmBanCaches };
```

Call in `server.js` after `connectRedis()` resolves and before `server.listen()`. Also register a `'ready'` listener on `pubClient` for Redis reconnects — registered **after** `connectRedis()` so it only fires on future reconnects, not the initial connect that is already handled by the explicit `await`.

```javascript
await connectDB();
await connectRedis();
io.adapter(createAdapter(pubClient, subClient));
perfSubClient.subscribe("__perf_mode__", (mode) => { setPerformanceMode(mode); });
await validateCounts({ deleteStaleSockets: true });

// 1. Initial warm-up — await so Sets are populated before accepting traffic
await warmBanCaches();

// 2. Re-warm on Redis reconnect (Redis crash/restart while PM2 stays running).
//    Registered AFTER connectRedis() so 'ready' has already fired once and
//    this listener only catches future reconnect events.
pubClient.on("ready", () => {
  warmBanCaches().catch((err) => console.error("Ban cache re-warm failed:", err));
});

server.listen(PORT, async () => { ... });
```

`sAdd` is atomic and idempotent. The warm-up fires one MongoDB query and one Redis pipeline; it completes in under 100ms on any realistic banned-user count.

---

### Change 4 — Trust Redis for ban checks; remove MongoDB fallbacks (`modules/user/controller.js`)

`**isUserBannedController**` — remove the `findUserByName` fallback. `BANNED_USERS_KEY` is the source of truth; it is warm at startup (Change 3) and kept in sync on every ban/unban.

```javascript
async function isUserBannedController(req, res) {
  const { name } = req?.body;
  try {
    const isBanned = !!(await redis.sIsMember(BANNED_USERS_KEY, name));
    return sendResponse(
      res,
      { isBanned, userName: name },
      "User Data Retrieved Successfully",
      200,
    );
  } catch (error) {
    sendError(res, "Internal server error", 500);
  }
}
```

`**registerUserController**` — replace `findBannedUserByIp` (MongoDB) with `sIsMember(BANNED_IPS_KEY, ip)` (Redis). Remove the parallel MongoDB ban check entirely; only check username availability against MongoDB.

```javascript
async function registerUserController(req, res) {
  const { name, clientIp, inComingClientIp } = req?.body;
  try {
    const ip = inComingClientIp || clientIp;

    // 1️⃣ IP ban check via Redis (warm at startup, updated on every ban action)
    if (ip) {
      const ipBanned = await redis.sIsMember(BANNED_IPS_KEY, ip);
      if (ipBanned) {
        return sendError(res, "You are banned from creating new users", 403);
      }
    }

    // 2️⃣ Username availability — MongoDB (no Redis equivalent for all usernames)
    const existingUser = await userService.findUserByName(name);
    if (existingUser) {
      return sendError(res, "User name already taken!", 400);
    }

    // 3️⃣ Rate limit check
    if (ip) {
      const existing = await redis.get(`${REG_RATE_LIMIT_PREFIX}${ip}`);
      if (existing !== null) {
        return sendError(
          res,
          "Account creation limit reached. Try again in 10 minutes.",
          429,
        );
      }
    }

    // 4️⃣ Create user
    await userService.createUser(name, ip);

    if (ip) {
      await redis.set(`${REG_RATE_LIMIT_PREFIX}${ip}`, "1", {
        NX: true,
        EX: REG_RATE_LIMIT_TTL,
      });
    }

    sendResponse(res, null, "User created successfully", 201);
  } catch (error) {
    console.log(error);
    sendError(res, "Internal server error", 500);
  }
}
```

`**updateUser**` — maintain `BANNED_IPS_KEY` alongside `BANNED_USERS_KEY` in the ban path. Import `BANNED_IPS_KEY` from `const_config.js`.

```javascript
// IP-based bulk ban:
if (ipAddress && isBanned === true) {
  const bannedNames = await userService.banAllUsersByIp(ipAddress);
  if (bannedNames.length > 0) {
    const pipeline = redis.multi();
    pipeline.sAdd(BANNED_USERS_KEY, bannedNames);
    pipeline.sAdd(BANNED_IPS_KEY, ipAddress); // NEW
    await pipeline.exec();
    await broadcastBanToAllRooms(bannedNames);
  }
  return sendResponse(res, null, "Users Banned Successfully", 200);
}

// Single-user ban/unban:
if (isBanned === true) {
  await redis.sAdd(BANNED_USERS_KEY, name);
  if (user.ipAddress) await redis.sAdd(BANNED_IPS_KEY, user.ipAddress); // NEW
} else {
  await redis.sRem(BANNED_USERS_KEY, name);
  // Do NOT remove from BANNED_IPS_KEY on single-user unban — other accounts
  // sharing that IP may still be banned. IP removal requires explicit admin action.
}
```

---

### Change 5 — Room cleanup for new Redis keys (`socket/roomManager.js`)

`**deleteRoom(roomId)**` — add cleanup for the sorted set and pinned cache:

```javascript
await redis.del(`${REDIS_MSG_CACHE_PREFIX}${roomId}`);
await redis.del(`${REDIS_PINNED_MSG_PREFIX}${roomId}`);
```

`**deleteAllRooms()**` — `deleteAllRooms` already calls `redis.sMembers(REDIS_ROOMS_SET)` at the top and has all room IDs in `roomIds`. Use those directly — no keyspace scan needed.

```javascript
// After the existing Promise.all block, using roomIds already fetched above:
if (roomIds.length > 0) {
  await Promise.all(
    roomIds.flatMap((id) => [
      redis.del(`${REDIS_MSG_CACHE_PREFIX}${id}`),
      redis.del(`${REDIS_PINNED_MSG_PREFIX}${id}`),
    ])
  );
}
```

Both `REDIS_MSG_CACHE_PREFIX` and `REDIS_PINNED_MSG_PREFIX` are imported from `const_config.js`.

---

### Change 6 — Fix `flushReactionBatch` mode-awareness (`modules/chat/service.js`)

Replace the `setInterval` with the same self-rescheduling `setTimeout` pattern used by `flushMessageBatchLoop` and `drainRoomCountersLoop`.

```javascript
// Replace:
//   setInterval(flushReactionBatch, getCurrentPerformanceMode().settings.batchFlush);

async function flushReactionBatchLoop() {
  try {
    await flushReactionBatch();
  } catch (err) {
    console.error("Reaction flush loop error:", err);
  } finally {
    const next = getCurrentPerformanceMode().settings.batchFlush;
    setTimeout(flushReactionBatchLoop, next);
  }
}
flushReactionBatchLoop();
```

---

### Change 7 — `ipify.org` timeout and fallback (`football-next-score8o8/src/utils/getClientIp.ts`)

Add a 5s `AbortController` timeout and two fallback services. Silent failure returning `""` is already the correct behaviour — the user can still register and chat; they just cannot be banned by IP.

```typescript
const IP_SERVICES = [
  { url: "https://api.ipify.org?format=json", extract: (d: any) => d?.ip },
  { url: "https://api.my-ip.io/v2/ip.json", extract: (d: any) => d?.ip },
  { url: "https://api4.my-ip.io/ip.json", extract: (d: any) => d?.ip },
];

export async function fetchClientIp(): Promise<string> {
  for (const service of IP_SERVICES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(service.url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) continue;
      const data = await response.json();
      const ip = service.extract(data);
      if (ip) return ip;
    } catch {
      // Try next service
    }
  }
  return "";
}
```

---

### Change 8 — Cap React messages array (`football-next-score8o8/src/components/chatBox/chatBox.tsx`)

Re-enable `STORE_MESSAGES_LIMIT`. Set to 300 — enough to scroll recent chat without unbounded growth.

```typescript
const STORE_MESSAGES_LIMIT = 300;
```

Apply on every live `setMessages` append (NOT on the initial history load, which is already capped at 200 by the backend):

```typescript
setMessages((prev) => [...prev, newMsg].slice(-STORE_MESSAGES_LIMIT));
```

Applies to: `room_message` handler, `message_reaction_updated` handler, and system/disconnect messages.

---

### Change 9 — Change client fetch cache mode (`football-next-score8o8/src/utils/fetchChatMessages.ts`)

Change `cache: "no-store"` to `cache: "default"`. With `"default"`, the browser respects `Cache-Control` headers from the server.

```typescript
const messageData = await fetchChatMessages({ cache: "default" }, roomId);
```

Optionally, add a short `Cache-Control` header in `getRoomMessagesController` to allow nginx / browser caching for the burst window:

```javascript
res.set("Cache-Control", "public, max-age=5");
```

---

## Files Changed


| File                                                        | Change                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `utils/const_config.js`                                     | Add `REDIS_MSG_CACHE_PREFIX`, `REDIS_PINNED_MSG_PREFIX`, `BANNED_IPS_KEY`, `MSG_CACHE_LIMIT`, `PINNED_MSG_CACHE_TTL`                                                                                                                                                            |
| `modules/chat/service.js`                                   | `saveChatMessageService`: ZADD to sorted set on every message; `retrieveRoomMessagesService`: Redis-first with per-instance coalescing; add `getRecentMessagesWithCache` and `cachePopulationInFlight`; replace `setInterval(flushReactionBatch)` with `flushReactionBatchLoop` |
| `modules/user/warmup.js` *(new)*                            | `warmBanCaches()` — seeds `BANNED_USERS_KEY` and `BANNED_IPS_KEY` from MongoDB at startup                                                                                                                                                                                       |
| `modules/user/controller.js`                                | `isUserBannedController`: remove MongoDB fallback; `registerUserController`: replace `findBannedUserByIp` with `sIsMember(BANNED_IPS_KEY)`; `updateUser`: maintain `BANNED_IPS_KEY` in ban path                                                                                 |
| `socket/roomManager.js`                                     | `deleteRoom`: del sorted set and pinned cache keys; `deleteAllRooms`: scan and del all `__room_msg_cache__:`* and `__room_pinned__:*` keys                                                                                                                                      |
| Server entry point                                          | `await warmBanCaches()` after Redis connects                                                                                                                                                                                                                                    |
| `football-next-score8o8/src/utils/getClientIp.ts`           | Add 5s timeout + two fallback IP services                                                                                                                                                                                                                                       |
| `football-next-score8o8/src/utils/fetchChatMessages.ts`     | Change `cache: "no-store"` to `cache: "default"`                                                                                                                                                                                                                                |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Re-enable `STORE_MESSAGES_LIMIT = 300`; apply `.slice(-STORE_MESSAGES_LIMIT)` on all live `setMessages` appends                                                                                                                                                                 |


No changes to: MongoDB models, socket event names/payloads, `football-admin` frontend code, or `package.json`.

> **Admin note:** The admin frontend (`football-admin`) calls `GET /get-room-messages?roomId=…&noLimit=true` and always has. The `noLimit=true` branch in `retrieveRoomMessagesService` bypasses the Redis sorted set entirely and goes straight to MongoDB with `.limit(500)`. The admin always gets fresh, full history. No changes to admin code are required and no admin behaviour changes.

---

## Edge Cases & Decisions

### Pinned message cache and admin pin action

Admin sends a pinned message via the `admin_room_message` socket event with `isPinned: true`. This calls `saveChatMessageService` which now (Change 1) writes to the Redis sorted set AND, because `message.isPinned` is true, overwrites `__room_pinned__:{roomId}` in the same pipeline. The pinned message cache is updated instantly — new users loading history see the correct pinned message right away, with no stale window.

**Without this fix:** the pinned cache would hold the old pinned message for up to 30s after the admin pins a new one, because the cache is only updated on a read-path miss, never on write. This is a conflict between the pin flow and the caching plan that is explicitly addressed here.

There is no "unpin" mechanism — the frontend always shows the most recent `isPinned: true` message. Pinning a new message naturally replaces the cached pinned message via the write above.

---

### Admin path is fully isolated from the cache

The admin always passes `noLimit=true`. In `retrieveRoomMessagesService`, the `if (noLimit)` branch returns immediately from MongoDB with up to 500 messages — the Redis sorted set, `cachePopulationInFlight`, and the pinned message cache are never touched. The admin's reads are completely unaffected by this plan.

The only interaction is on the **write** side: admin messages sent via the `admin_room_message` socket event flow through `saveChatMessageService` exactly like user messages, so they land in the sorted set. This is correct — users loading history should see admin messages.

| Path | Cache used | Message limit | MongoDB hit |
|---|---|---|---|
| User: `noLimit` absent | Redis sorted set → MongoDB on miss | 200 | Only on cold cache |
| Admin: `noLimit=true` | None — direct MongoDB | 500 | Always |

---

### Sorted set and messages not yet in MongoDB

The sorted set is written immediately in `saveChatMessageService` — before the message reaches MongoDB. A user loading history will see messages that are still in the in-memory batch. If the server crashes before `flushMessageBatch`, those messages exist in the sorted set but never persist to MongoDB. This is acceptable: the message was already broadcast to all connected users at send time. A crash already loses in-flight batch messages — this is pre-existing behaviour, not a regression.

### Reactions in cached history

The sorted set stores messages at write time, before any reactions are applied. A user loading history will see messages with no reactions (or stale reactions). Live reactions arrive via `message_reaction_updated` socket events and update React state directly. This matches existing behaviour.

### `BANNED_IPS_KEY` and single-user unban

When a single user is unbanned, their IP is NOT removed from `BANNED_IPS_KEY`. Other accounts on the same IP may still be banned. IP removal from the Set requires explicit admin action (an IP-level unban flow). This should be noted for the admin interface.

### `deleteAllRooms` cleanup uses `roomIds`, not a keyspace scan

The `deleteAllRooms` function calls `redis.sMembers(REDIS_ROOMS_SET)` at the top and has all active room IDs. The new per-room cache keys (`__room_msg_cache__:{id}` and `__room_pinned__:{id}`) are deleted by iterating those IDs directly — no `KEYS` pattern scan needed. This avoids blocking Redis and keeps the cleanup deterministic.

### Per-instance coalescing map memory

`cachePopulationInFlight` holds at most one entry per room with an active cache miss. Each entry is a Promise that resolves as soon as the MongoDB query and Redis seed complete, then removed by `.finally()`. With 20 active rooms, the map holds at most 20 entries simultaneously — negligible memory.

### When are ban Sets loaded into Redis?

There are three situations:

| Event | Handler |
|---|---|
| PM2 instance starts | `await warmBanCaches()` in `server.js` startup — runs before `server.listen()` |
| Redis restarts (PM2 stays running) | `pubClient.on('ready', warmBanCaches)` — fires on every reconnect after the initial connect |
| Admin bans / unbans a user | `updateUser` controller — `sAdd` / `sRem` in real time |

The `'ready'` listener is registered **after** `connectRedis()` resolves, so the initial connect's `'ready'` event has already fired by that point and the listener only catches future reconnects. This prevents a double warm-up on startup.

Without the `'ready'` listener, a Redis restart while PM2 stays running would empty both Sets and leave banned users able to register new accounts and send messages until the next PM2 restart.

---

## Performance Analysis

### Assumptions

- 5 PM2 instances, Redis and MongoDB co-located on the same host (loopback, sub-millisecond RTT to Redis, ~5–15ms per MongoDB query)
- Default Mongoose connection pool: 5 connections per instance → **25 total MongoDB connections** across the cluster
- Champions League final peak: **20K concurrent users** opening the stream page within a 60-second window
- ~30% of users have a saved username → ~6K `isUserBanned` calls on connect
- ~10% of users register a new account → ~2K `registerUser` calls
- 1 main chat room, ~200 messages/min during the match

---

### Before — what actually happens at kick-off

Every user who loads the stream page triggers the same three requests in quick succession:

**1. Message history (every user — 20K requests)**

```
GET /get-room-messages?roomId=main_room
  → MessageModel.find({ roomId, timestamp: { $lt: now } }).limit(200)   [~10ms]
  → MessageModel.find({ roomId, isPinned: true }).limit(1)              [~5ms]
```

- 20K requests × 2 queries = **40K MongoDB queries** arriving in ~60 seconds
- 25 connection-pool slots handling 40K queued operations
- Queue depth per connection: 40K ÷ 25 = **1,600 queries per connection**
- Time for the last request in queue: 1,600 × 10ms = **16 seconds**
- Users at the back of the queue see a blank chat box for 16+ seconds

**2. Ban checks (~6K requests from users with saved usernames)**

```
POST /is-user-banned
  → redis.sIsMember(BANNED_USERS_KEY, name)   → false (user not banned)
  → User.findOne({ name })                    → [~10ms] — always hits MongoDB
```

- 6K MongoDB `findOne` queries added on top of the already-saturated pool
- These overlap with the message history burst window

**3. Registration IP ban check (~4K queries from 2K new users)**

```
POST /register-user
  → Promise.all([
      User.findOne({ ipAddress, isBanned: true }),   [~10ms]
      User.findOne({ name }),                         [~10ms]
    ])
```

- 2K users × 2 parallel queries = 4K MongoDB queries
- Again overlapping with the burst

**Total MongoDB burst load: ~50,000 queries in 60 seconds**

At 25 connection-pool slots, this queues ~2,000 operations per connection. The first users get their chat history in ~15ms. Users arriving 30 seconds later wait up to **30 seconds** for the pool to drain. During that window MongoDB CPU spikes, write latency for the message batch flush and counter drain also increases, and the entire cluster degrades together.

---

### After — the same kick-off with this plan

**1. Message history**

First user on each PM2 instance misses the Redis sorted set → `cachePopulationInFlight` coalesces all concurrent misses on that instance into **one** MongoDB query. Across 5 instances: **5 MongoDB queries total**, then Redis is warm. Every subsequent request:

```
GET /get-room-messages?roomId=main_room
  → redis.zRange(__room_msg_cache__:main_room, 0, -1)   → ~0.5ms, no MongoDB
  → redis.get(__room_pinned__:main_room)                → ~0.5ms, no MongoDB
```

- 19,995 of 20K requests never touch MongoDB
- Response time: **~1ms** for everyone regardless of when they arrive
- MongoDB connection pool is idle during the burst

**2. Ban checks**

```
POST /is-user-banned
  → redis.sIsMember(BANNED_USERS_KEY, name)   → ~0.5ms, no MongoDB
```

- 0 MongoDB queries for all 6K ban checks

**3. Registration IP ban check**

```
POST /register-user
  → redis.sIsMember(BANNED_IPS_KEY, ip)   → ~0.5ms, no MongoDB
  → User.findOne({ name })                → [~10ms] — still needed for username uniqueness
```

- Reduced from 2 parallel MongoDB queries to 1 per registration
- 2K registrations → 2K MongoDB queries instead of 4K

**Total MongoDB burst load: ~2,000 queries in 60 seconds (username uniqueness checks only)**

---

### Before vs After — numbers

| Metric | Before | After | Change |
|---|---|---|---|
| MongoDB queries at kick-off burst | ~50,000 | ~2,005 | **−96%** |
| Message history response time (peak) | up to 30s (queue) | ~1ms | **−99.9%** |
| Message history response time (normal) | ~15ms | ~1ms | **−93%** |
| Ban check MongoDB queries | ~6,000 | 0 | **−100%** |
| IP ban check MongoDB queries | ~4,000 | 0 | **−100%** |
| MongoDB connection pool pressure | Saturated (2,000 ops/connection queued) | Near idle | Eliminated |
| Reaction flush mode-awareness | Broken (setInterval locked at startup) | Fixed | Bug fixed |
| `flushMessageBatch` mode-awareness | Fixed (previous plan) | Fixed | Unchanged |
| Redis memory added | 0 | ~1.5MB (20 rooms × 60KB each + ban Sets) | Negligible |
| Redis ops/min added | 0 | ~2 ZADD + ZREMRANGEBYRANK per message sent | Negligible |

---

### Why this needs no infrastructure changes

The existing system already has everything this plan uses:

| Resource | Already present | How we use it |
|---|---|---|
| Redis instance | Yes — Socket.io adapter, rate limiting, room counts | Add sorted sets and ban Sets on the same connection (`pubClient`) |
| `pubClient` Redis connection | Yes — imported in `service.js` and `controller.js` | Already imported; no new connection needed |
| MongoDB | Yes | Still used for writes, admin reads, and username uniqueness |
| 5 PM2 instances | Yes | Per-instance `cachePopulationInFlight` Map uses existing Node.js process memory |

No new Redis servers, no read replicas, no MongoDB sharding, no CDN, no nginx changes (Cache-Control header is optional), no new npm packages, no PM2 config changes. The plan deploys as a normal `pm2 reload` — the ban warm-up runs automatically on each instance restart and the sorted sets populate as the first messages arrive.

The underlying reason the old code was expensive: **Redis was already running and available, but only used for writes** (rate limits, room counts, Socket.io pub/sub). MongoDB was being hit for every read even though the answers were identical for every user. This plan flips the read path to use the tool that was already there.


---

## Testing Checklist

- 20K simultaneous `GET /get-room-messages`, Redis warm: verify 0 MongoDB queries in profiler
- Same test with `FLUSHDB`: verify ≤5 MongoDB queries, all subsequent requests hit Redis
- Restart Redis mid-match (PM2 stays running): verify `pubClient` reconnects automatically and `warmBanCaches` re-fires via `'ready'` listener; `isUserBanned` returns correct ban status within seconds of Redis coming back
- Ban a user via admin: verify both `BANNED_USERS_KEY` and `BANNED_IPS_KEY` updated in Redis
- Unban a single user: verify `BANNED_USERS_KEY` updated, `BANNED_IPS_KEY` unchanged
- Block ipify via hosts file: verify fallback service used and IP captured within 5s
- Block all IP services: verify empty string returned, registration still succeeds
- 3-hour simulated match at 200 msg/min: verify React messages array stays ≤300 entries
- `POST /change-server-mode` to extreme: verify reaction flush cadence updates within one cycle
- Delete a room: verify `__room_msg_cache__:{roomId}` and `__room_pinned__:{roomId}` removed
- `deleteAllRooms`: verify `__room_msg_cache__:{roomId}` and `__room_pinned__:{roomId}` removed for every room that was active
- Admin `GET /get-room-messages?noLimit=true`: verify response always comes from MongoDB (500 messages), never from Redis sorted set; verify admin receives messages sent during the Redis-warm period correctly
- Admin pins a message: verify `__room_pinned__:{roomId}` is updated immediately (within the same request); new user loading history within 1s sees the new pinned message, not the old one
- Admin bans a user via the admin panel (PATCH `/update-user`): verify `BANNED_USERS_KEY` and `BANNED_IPS_KEY` both updated in Redis; banned user cannot send messages on next attempt

---

## Rollback

Revert `modules/chat/service.js` to restore the MongoDB-first read path. Revert `modules/user/controller.js` to restore the `findUserByName` fallback and `findBannedUserByIp`. Revert the two frontend files to restore `cache: "no-store"` and the original `fetchClientIp`.

Redis leftovers (`__room_msg_cache__:*`, `__room_pinned__:*`, `__banned_ips__`) are harmless and can be cleaned up manually if desired:

```bash
redis-cli --scan --pattern "__room_msg_cache__:*" | xargs redis-cli del
redis-cli --scan --pattern "__room_pinned__:*" | xargs redis-cli del
redis-cli del __banned_ips__
```

No MongoDB schema changes, no Socket.IO event changes, no new npm packages.