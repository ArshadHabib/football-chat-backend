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

## Files Changed

| File | Change |
|---|---|
| `modules/user/service.js` | `banAllUsersByIp(ipAddress)` — bulk bans by IP, returns banned names |
| `socket/roomManager.js` | `broadcastBanToAllRooms(userNames)` — emits `user_updated` globally via `io.emit()` (no Redis read, no room loop) |
| `modules/user/controller.js` | `updateUser` branches on `ipAddress` presence |
| `football-admin` `chat-user-name.tsx` | Includes `ipAddress` in patch payload when banning |
