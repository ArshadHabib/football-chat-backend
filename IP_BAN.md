# IP Ban

When an admin bans a user and their `ipAddress` is available in the admin UI, all users sharing that IP are banned simultaneously.

## Ban Flow

1. Admin clicks Ban in `chat-user-name.tsx` — payload includes `ipAddress` only when banning (not unbanning) and only if the IP is known: `if (!useData.isBanned && useData.ipAddress) payload.ipAddress = useData.ipAddress`
2. `PATCH /update-user` received with `{ name, ipAddress, isBanned: true }`
3. `banAllUsersByIp(ipAddress)` — `User.find({ ipAddress })` to collect names, then `User.updateMany({ ipAddress }, { isBanned: true })`
4. `redis.sAdd(BANNED_USERS_KEY, bannedNames)` — all usernames added to Redis Set in one call
5. `broadcastBanToAllRooms(bannedNames)` — loops through names, emits `user_updated` globally via `io.emit()` for each:
   ```js
   { name, isBanned: true, updatedBy: "admin", timestamp, eventType: "user_updated" }
   ```
6. Client `user_updated` listener matches on `data.name === userName` → sets `isUserBanned` state + updates `localStorage`

## Unban Flow

Unban is always single-user. Admin sends `{ name, isBanned: false }` — no `ipAddress`, no IP logic.
1. `userService.updateUser(name, { isBanned: false })` — `findOneAndUpdate`
2. `redis.sRem(BANNED_USERS_KEY, name)` — removes from Redis Set
3. **No `user_updated` broadcast emitted** — client finds out via the next `join_room` or page reload

## Single-User Ban (no IP)

When `ipAddress` is absent from the payload:
1. `userService.updateUser(name, { isBanned: true })` — `findOneAndUpdate`
2. `redis.sAdd(BANNED_USERS_KEY, name)` — adds to Redis Set
3. **No `user_updated` broadcast emitted** — banned user is silently blocked at next `room_message`

## Payload Reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Always | Username to ban/unban |
| `ipAddress` | string | Ban only, if available | Triggers IP-wide ban when present |
| `isBanned` | boolean | Always | `true` = ban, `false` = unban |

---

## Registration Rate Limit

Only 1 account can be created per IP in 10 minutes.

### How it works

Redis `SET NX EX` — single atomic operation, sets a key only if it does not already exist, with expiry attached.

- First registration attempt: key `reg_ratelimit:{ip}` does not exist → Redis creates it with 600s TTL → registration proceeds
- Any subsequent attempt within 10 minutes: key already exists → Redis returns `null` → 429 rejected
- After 10 minutes: Redis auto-expires the key → IP can register again
- The TTL is set only after `createUser` succeeds — if the DB write fails, the key is never set and the IP can retry immediately
- Skipped entirely if IP is empty — `attachClientIp` middleware converts `127.0.0.1` and `::1` to `""` before the controller, so localhost is naturally excluded
- Banned IP check runs first — banned IPs are rejected before the rate limit check even runs

### Controller flow (registration)

```
1. findBannedUserByIp(ip)                           → if banned: 403
2. findUserByName(name)                              → if taken: 400
3. redis.set(reg_ratelimit:{ip}, NX EX 600)          → if exists: 429
4. createUser(name, ip)
```

### Constants (`utils/const_config.js`)

| Constant | Value | Description |
|---|---|---|
| `REG_RATE_LIMIT_PREFIX` | `"reg_ratelimit:"` | Redis key prefix |
| `REG_RATE_LIMIT_TTL` | `600` | Window in seconds (10 minutes) |

---

## Server-Side Ban Enforcement (Redis Set)

### Problem
The frontend stores `isBanned` in localStorage. A user can flip it to `false` in DevTools and keep sending messages since the server did not verify ban status on each message.

### Solution
A Redis Set `__banned_users__` acts as the server-side source of truth across all processes.

### Redis Key
`__banned_users__` (`BANNED_USERS_KEY`) — a single shared Set, consistent across all PM2 processes via the shared Redis instance.

### On `join_room`

Ban check on join is currently **disabled** — banned users are allowed to join rooms. Enforcement happens at `room_message` level instead.

The join block code is commented out in `socketHandler.js` and can be re-enabled if needed. The commented block also includes self-healing: if a user is banned in MongoDB but missing from the Redis Set, it would re-add them.

### On `room_message`

Ban check is folded into the rate limit pipeline — single round trip for both:

```
pipeline = redis.multi()
pipeline.sIsMember(__banned_users__, senderName)   ← results[0]: ban check
pipeline.incr(ratelimit:{ip})                       ← results[1]: rate limit count
pipeline.expire(ratelimit:{ip}, window, NX)

results[0] = isBanned  → true: drop message silently, return
results[1] = msgCount  → over limit: emit server_rate_limit, return
→ both pass: broadcast room_message
```

No extra Redis round trip — ban check costs nothing on top of the existing pipeline.

### Known Loophole (fix ready, commented out)

`senderName` in `room_message` comes from the frontend payload — a banned user could send a different username in the payload and bypass the `sIsMember` check.

**Fix (implemented but commented out):**
- At `join_room`, store verified username server-side: `socket.senderName = senderName`
- In `room_message`, use `socket.senderName` instead of `data.senderName` for the ban check
- `socket.senderName` cannot be tampered with by the client
- Works per-process — a user's socket and their messages always live on the same process

**To enable:** uncomment `socket.senderName = senderName` in `join_room` and replace `senderName` with `socket.senderName ?? senderName` in the `room_message` pipeline check.

---

## Files Changed

| File | Change |
|---|---|
| `modules/user/service.js` | `banAllUsersByIp(ipAddress)` — finds + bulk bans by IP, returns banned names |
| `modules/user/controller.js` | `updateUser` branches on `ipAddress` presence; `registerUserController` has reg rate limit |
| `socket/roomManager.js` | `broadcastBanToAllRooms(userNames)` — emits `user_updated` globally via `io.emit()` |
| `football-admin/src/sections/matches/chat-user-name.tsx` | Includes `ipAddress` in patch payload when banning |
