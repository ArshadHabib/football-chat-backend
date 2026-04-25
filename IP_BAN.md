# IP Ban

When an admin bans a user and includes their `ipAddress` in the payload, all users sharing that IP are banned simultaneously.

## Ban Flow

1. Admin calls `PATCH /update-user` with `{ name, ipAddress, isBanned: true }`
2. Backend bans every user in MongoDB with that `ipAddress` via `updateMany`
3. Backend emits `user_updated` (`isBanned: true`) globally via `io.emit()` for each banned username
4. Each banned user's frontend detects the event (matched by `name`) and updates their `isBanned` state

## Unban Flow

Unban is always single-user. Admin sends `{ name, isBanned: false }` — only that user is unbanned, no IP logic applies.

## Payload Reference

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | Always | Username to ban/unban |
| `ipAddress` | string | Ban only | Triggers IP-wide ban when present |
| `isBanned` | boolean | Always | `true` = ban, `false` = unban |

## Registration Rate Limit

Only 1 account can be created per IP in 10 minutes.

### How it works

Redis `SET NX EX` is used — this is a single atomic operation that sets a key **only if it does not already exist**, with an expiry time attached.

- First registration attempt: key `reg_ratelimit:{ip}` does not exist → Redis creates it with a 600s TTL → registration proceeds
- Any subsequent attempt within 10 minutes: key already exists → Redis returns `null` → request is rejected with 429
- After 10 minutes: Redis auto-expires the key → the IP can register again
- The TTL is set at the moment of first registration, not reset on each attempt — so the window is always 10 minutes from the first account created
- Skipped entirely if IP is empty — the `attachClientIp` middleware already converts `127.0.0.1` and `::1` to `""` before the request reaches the controller, so localhost is naturally excluded

### Constants (in `utils/const_config.js`)

| Constant | Value | Description |
|---|---|---|
| `REG_RATE_LIMIT_PREFIX` | `"reg_ratelimit:"` | Redis key prefix |
| `REG_RATE_LIMIT_TTL` | `600` | Window in seconds (10 minutes) |

## Server-Side Ban Enforcement (Redis Set)

### Problem
The frontend stores `isBanned` in localStorage. A user can open DevTools, flip it to `false`, and keep sending messages since the server does not verify ban status on each message.

### Solution
A Redis Set `__banned_users__` acts as the server-side source of truth across all processes. localStorage flow is untouched — this sits on top of it.

### Redis Key
`__banned_users__` — a single shared Set, consistent across all PM2 processes via the shared Redis instance.

### On Ban — `modules/user/controller.js` (`updateUser`)

**IP ban** (`ipAddress` + `isBanned: true`):
1. `banAllUsersByIp(ipAddress)` — MongoDB `updateMany({ ipAddress }, { isBanned: true })`, returns all banned usernames
2. `redis.sAdd(BANNED_USERS_KEY, bannedNames)` — adds all usernames to the Redis Set in one call
3. `broadcastBanToAllRooms(bannedNames)` — emits `user_updated` globally for each username

**Single user ban** (`isBanned: true`, no `ipAddress`):
1. MongoDB `findOneAndUpdate` sets `isBanned: true`
2. `redis.sAdd(BANNED_USERS_KEY, name)` — adds username to the Redis Set

### On Unban — `modules/user/controller.js` (`updateUser`)

1. MongoDB `findOneAndUpdate` sets `isBanned: false`
2. `redis.sRem(BANNED_USERS_KEY, name)` — removes username from the Redis Set

### On `join_room` — `socket/socketHandler.js`

Ban check on join is currently **disabled** — banned users are allowed to join rooms. Enforcement happens at the `room_message` level instead.

The join block code is commented out in `socketHandler.js` and can be re-enabled if join blocking is needed in the future.

### On `room_message` — `socket/socketHandler.js`

Ban check is folded into the existing rate limit Redis pipeline — both run in a single round trip:

```
pipeline = redis.multi()
pipeline.sIsMember(__banned_users__, senderName)   ← ban check
pipeline.incr(ratelimit:{ip})                       ← rate limit (if IP present)
pipeline.expire(ratelimit:{ip}, window, NX)

results = pipeline.exec()
  results[0] = isBanned  → true: drop message silently (no feedback to user), return
  results[1] = msgCount  → over limit: emit server_rate_limit, return
  → both pass: broadcast room_message
```

No extra Redis round trip — ban check costs nothing on top of the existing pipeline.

### Known Loophole (fix ready, commented out)
`senderName` in `room_message` comes from the frontend payload — a banned user could change it to a different username and bypass the `SISMEMBER` check.

**Fix (implemented but commented out):**
- At `join_room`, store the verified username server-side: `socket.senderName = senderName`
- In `room_message`, use `socket.senderName` for the ban check instead of `data.senderName`
- `socket.senderName` is set by the server at join time and cannot be tampered with by the client
- Works per-process — each user's socket and their messages always live on the same process, so no cross-process issue

**To enable:** uncomment `socket.senderName = senderName` in `join_room` and replace `senderName` with `socket.senderName` in the `room_message` pipeline check.

## Files Changed

| File | Change |
|---|---|
| `modules/user/service.js` | `banAllUsersByIp(ipAddress)` — bulk bans by IP, returns banned names |
| `socket/roomManager.js` | `broadcastBanToAllRooms(userNames)` — emits `user_updated` globally via `io.emit()` (no Redis read, no room loop) |
| `modules/user/controller.js` | `updateUser` branches on `ipAddress` presence |
| `football-admin` `chat-user-name.tsx` | Includes `ipAddress` in patch payload when banning |
