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

## Files Changed

| File | Change |
|---|---|
| `modules/user/service.js` | `banAllUsersByIp(ipAddress)` — bulk bans by IP, returns banned names |
| `socket/roomManager.js` | `broadcastBanToAllRooms(userNames)` — emits `user_updated` globally via `io.emit()` (no Redis read, no room loop) |
| `modules/user/controller.js` | `updateUser` branches on `ipAddress` presence |
| `football-admin` `chat-user-name.tsx` | Includes `ipAddress` in patch payload when banning |
