# showViews Gate & User Count Broadcast

## Feature

The `showViews` field on `Match.games` (MongoDB, football-backend) controls whether the live viewer count is shown to users on the match page. When an admin toggles it off, users should see "Active Chat Room" instead of a number. When toggled on, the animated count appears.

The admin dashboard always sees counts regardless of this setting.

---

## The Problem (before this fix)

### 1. Count leaked via network tab

`showViews` was only enforced **client-side**. The server always emitted `room_user_count_update` to all connected clients. Any technical user watching the WebSocket traffic in the browser network tab could see the count even when the admin had turned it off.

### 2. `join_result` also leaked the count

When a user joined a room, the server responded with:
```json
["join_result", { "success": true, "roomId": "...", "usersCount": 2 }]
```
`usersCount` was always present regardless of `showViews`.

### 3. `showViews` not stored on room creation

When the football-backend created a chat room, it only sent `roomId` to the chat backend. The chat backend had no knowledge of the current `showViews` value for that room until an admin manually toggled it.

### 4. No revalidation on `showViews` change

When admin toggled `showViews`, the DB was updated and the socket event fired — but the Next.js page cache was not revalidated. A fresh page load would still serve the old `showViews` value from ISR cache until some other event triggered revalidation.

### 5. User count debounce broken across 5 instances

The debounce was in-memory per process (`userCountUpdateTimeout`, `roomUserCountUpdates` Map). With 5 PM2 instances, every join/leave triggered up to **5 independent broadcasts** to the room — one per instance. Each process ran its own timer independently with no coordination.

Additionally, the debounce was **global** (one timer for all rooms) — any join in any room reset the timer for every other room.

---

## What Was Fixed

### Fix 1 — Server-side showViews gate on `room_user_count_update`

`room_user_count_update` is now suppressed entirely at the server when `showViews` is false. The event never reaches the client, so nothing appears in the network tab.

**How:** A new Redis hash `__room_show_views__` stores the `showViews` state per room. In `broadcastUserCountUpdates` (now part of `scheduleUserCountUpdate`), the value is read from Redis before emitting. If `"false"`, the emit is skipped.

`null` (key not set — rooms created before this deploy) is treated as `"true"` to preserve existing behaviour.

### Fix 2 — `join_result` no longer leaks count

`joinRoom` in `roomManager.js` reads `showViews` from Redis and conditionally includes `usersCount` in the return object:

```js
return {
  success: true,
  roomId,
  ...(showViews && { usersCount: count }),
};
```

When `showViews` is false, `usersCount` is absent from the payload entirely — not zero, absent.

### Fix 3 — `showViews` passed on room creation

**football-backend** now passes `showViews` to the chat backend when creating a room via `createSingleSocketRoomApiCall(roomId, showViews)`. The value comes from the match document at the time of creation — not a default.

Three call sites updated:
- `modules/match/service.js` — `updateGame` reads `showViews` from the `findOneAndUpdate` result
- `schedulers/playerScheduler.js` — `scheduleScrapingJobs` passes `game?.showViews`
- `schedulers/playerScheduler.js` — `scheduleScrapingJobForSingleMatch` passes `match?.showViews` (required adding `showViews` to `getMatchDetailsForAdmin` return object)

`createRoom(roomId, showViews = true)` in `roomManager.js` now accepts and stores the value. Default `true` protects any call site not yet passing the argument.

The bulk room creation path (`socket_service.js` → `createSocketRoomsForMatchService`) also passes `game?.showViews` on reset/scrape-all.

### Fix 4 — Revalidation on showViews change

`updateShowMatchViewsService` in `football-backend/modules/match/service.js` now calls `revalidateMatchPage` and `revalidateMatchSlugPage` after the DB update, consistent with every other game update service.

### Fix 5 — Cross-process debounce via Redis NX

Replaced in-memory debounce entirely with a **per-room Redis NX throttle**.

**Before:**
```js
// per-process — 5 instances = 5 independent timers = up to 5 broadcasts per join
roomUserCountUpdates.set(roomId, usersCount);
clearTimeout(userCountUpdateTimeout);
userCountUpdateTimeout = setTimeout(() => broadcastUserCountUpdates(), debounceMs);
```

**After:**
```js
async function scheduleUserCountUpdate(roomId) {
  const debounceMs = getCurrentPerformanceMode().settings.userCountUpdateDebounce;
  const debounceKey = `__user_count_debounce__:${roomId}`;

  const won = await redis.set(debounceKey, "1", { NX: true, PX: debounceMs });
  if (!won) return; // another process already holds the lock

  setTimeout(async () => {
    // ... read fresh count from Redis, check showViews, emit once
  }, debounceMs);
}
```

- `SET NX PX` — only one process wins per debounce window per room. All others return immediately.
- Count is read **fresh from Redis** at broadcast time — always accurate regardless of which process won.
- **Per-room** throttle — rooms are independent, no global timer interference.
- Debounce key auto-expires via `PX` — no manual cleanup needed.

### Fix 6 — Skip broadcast when count unchanged

A new Redis hash `__room_last_broadcast__` stores the last count emitted per room. Before broadcasting, the current count is compared to the last broadcast value. If identical, the emit is skipped.

```js
const [countRaw, lastBroadcastRaw] = await Promise.all([
  redis.hGet(REDIS_ROOM_COUNTS, roomId),
  redis.hGet(REDIS_ROOM_LAST_BROADCAST, roomId),
]);
const count = parseInt(countRaw) || 0;
const lastBroadcast = parseInt(lastBroadcastRaw) || 0;
if (count === lastBroadcast) return;

io.to(roomId).emit("room_user_count_update", { roomId, usersCount: count });
await redis.hSet(REDIS_ROOM_LAST_BROADCAST, roomId, count.toString());
```

Handles high-churn scenarios where users join and leave within the same debounce window leaving the count unchanged.

---

## Redis Keys Added

| Key | Type | Purpose | Cleanup |
|---|---|---|---|
| `__room_show_views__` | Hash (roomId → "true"/"false") | showViews state per room | `deleteRoom`, `deleteAllRooms` |
| `__room_last_broadcast__` | Hash (roomId → count string) | Last emitted count per room | `deleteRoom`, `deleteAllRooms` |
| `__user_count_debounce__:{roomId}` | String with TTL | Cross-process NX lock per room | Auto-expires via PX |

---

## Files Changed

### football-backend
| File | Change |
|---|---|
| `utils/socket_api_calls.js` | `createSingleSocketRoomApiCall` now accepts and forwards `showViews` |
| `modules/match/service.js` | `updateGame` passes `showViews` to room creation; `getMatchDetailsForAdmin` returns `showViews`; `updateShowMatchViewsService` calls revalidation |
| `schedulers/playerScheduler.js` | Both `createSingleSocketRoomApiCall` call sites pass `showViews` |

### football-chat-backend
| File | Change |
|---|---|
| `socket/roomManager.js` | Core changes — all Redis keys, `createRoom`, `joinRoom`, `updateViewsVisibility`, `scheduleUserCountUpdate`, `deleteRoom`, `deleteAllRooms` |
| `socket/socketHandler.js` | `scheduleUserCountUpdate` call sites updated (removed `usersCount` arg) |
| `modules/chat/controller.js` | `createSingleSocketRoomController` reads and passes `showViews`; `updateShowViewsVisibilityToUsersController` awaits `updateViewsVisibility` |
| `modules/chat/socket_service.js` | `createSocketRoomsForMatchService` passes `game?.showViews` to `createRoom` |

---

## Broadcast Flow (after fix)

```
User joins room
  → joinRoom() in roomManager
      → Redis hIncrBy (count++)
      → Redis hGet __room_show_views__ → include usersCount in join_result only if true
      → emit join_result to joining socket
  → scheduleUserCountUpdate(roomId)
      → SET __user_count_debounce__:{roomId} NX PX {debounceMs}
      → if won: setTimeout(debounceMs)
          → check room exists
          → check __room_show_views__ → skip if false
          → read count + lastBroadcast in parallel
          → skip if count === lastBroadcast
          → emit room_user_count_update to room
          → store new lastBroadcast

Admin toggles showViews
  → football-backend updates DB
  → football-backend calls revalidateMatchPage + revalidateMatchSlugPage
  → football-backend HTTP POST → chat-backend /update-show-views-visibility-to-users
      → updateViewsVisibility()
          → Redis hSet __room_show_views__ (persist new value)
          → io.to(roomId).emit("update_views_visibility", { showViews })
              → client setViewShow(showViews) — UI toggles immediately
```

---

## Performance: Before vs After

### Socket traffic — `room_user_count_update`

| Scenario | Before | After |
|---|---|---|
| 1 user joins, 5 instances running | Up to **5 emits** to the room (one per process) | **1 emit** — NX lock ensures single winner |
| 100 users join in 1ms | Up to 5 rapid-fire emits, each with slightly stale count | **1 emit** after debounce window with accurate count |
| User joins then leaves, net count unchanged | Broadcast fires both times | **0 emits** — last broadcast check skips identical count |
| Active room, continuous joins/leaves | Global timer reset on every event across all rooms | **Per-room** independent throttle — rooms don't block each other |
| `showViews = false`, user joins | Count emitted to all clients (visible in network tab) | **0 emits** — suppressed before leaving the server |

### Redis operations per join/leave

| Operation | Before | After |
|---|---|---|
| NX debounce lock | None | +1 `SET NX PX` (losing processes return immediately after) |
| Count read at broadcast | 1x `hGet REDIS_ROOM_COUNTS` | 2x `hGet` in parallel (count + lastBroadcast) — same round trip via `Promise.all` |
| Count write | None | +1 `hSet REDIS_ROOM_LAST_BROADCAST` (only when count changed and emitted) |
| `usersCount` param to `scheduleUserCountUpdate` | Passed from `hIncrBy` result | Removed — read fresh from Redis at broadcast time |

Net cost: one extra Redis call per join/leave (the NX lock). This is negligible — `joinRoom` and `leaveRoom` already do multiple Redis calls (`hIncrBy`, `sIsMember`, `hSet`).

### At scale (50k–75k concurrent users, 5 instances)

**Broadcast volume reduction:**
- Before: each join/leave could produce 5 `room_user_count_update` emits per room
- After: maximum 1 emit per room per debounce window
- **~5x reduction** in `room_user_count_update` socket traffic

**Eliminated redundant emits:**
- Before: churn events (1 join + 1 leave = net 0 change) still produced broadcasts
- After: skipped entirely when count matches last broadcast

**Memory freed per process:**
- Removed `roomUserCountUpdates` Map (was growing with every active room)
- Removed `userCountUpdateTimeout` variable
- Removed `broadcastUserCountUpdates` function

**Debounce accuracy:**
- Before: one global timer — a busy room could starve quiet rooms from getting their count update
- After: per-room timers via Redis TTL — every room gets its own independent window

---

## Admin Updates — Unaffected

Admin counts always flow via `scheduleAdminRoomUpdate` → `notifyAdminRoomUpdate` → `io.to("__admins__").emit("admin_room_update", roomData)`. This path reads directly from Redis and is completely independent of `showViews` and the user count broadcast path. Admin dashboard always sees accurate counts.
