# IP-Based Chat Rate Limiting — Implementation Plan

## Problem

A single user can create multiple accounts from the same IP and use them simultaneously to spam the chat. The frontend enforces 1 message per 3 seconds **per connection**, but with 10 accounts open that becomes effectively 10 messages every 3 seconds from the same IP — bypassing the frontend limit entirely.

Example from production: IP `45.84.136.240` had 7 accounts (BALUMPIA20, BALUMPIA26, BALUMPIA30, BALUMPIA33, BALUMPIA35, BALUMPIA41, BALUMPIA49) all active at the same time.

---

## Why In-Memory Won't Work

The app runs as **5 PM2 cluster processes**. Each process has its own isolated memory. An in-memory `Map` would be per-process — if the spammer's 10 accounts are distributed across processes by nginx round-robin, each process sees only ~2 messages and the limit is never triggered.

---

## Solution: Redis INCR + EXPIRE (Shared Across All 5 Processes)

Redis is already in use for room state, socket adapter, and performance mode pub/sub (see `CLUSTER_MIGRATION.md`). The same `pubClient` instance used there will be used here.

**How it works:**

```
User on IP 45.84.136.240 sends a message on any process:
  → INCR ratelimit:45.84.136.240   →  count = 1  (also SET TTL = 10s on first hit)
  → count 1 ≤ 15  → message goes through

Another account from same IP on a different process:
  → INCR ratelimit:45.84.136.240   →  count = 2
  → count 2 ≤ 15  → message goes through

...

16th message across all accounts:
  → INCR ratelimit:45.84.136.240   →  count = 16
  → count 16 > 15  → BLOCKED. TTL retrieved → retryAfter sent to client
```

The counter is shared — all 5 processes increment the same Redis key. The limit is enforced globally.

---

## Rate Limit Values: Integrated Into Performance Mode (Option A)

The limits are added to `utils/perfomance_config.js` alongside the existing per-mode settings. When `POST /change-server-mode` is called, the new limits propagate to all 5 processes instantly via the existing `__perf_mode__` Redis pub/sub channel — no restart needed.

**Proposed values:**

| Mode    | Max messages | Window |
|---------|-------------|--------|
| normal  | 15 msgs     | 10s    |
| peak    | 10 msgs     | 10s    |
| extreme | 5 msgs      | 10s    |

These allow a single honest user (1 msg/3s = ~3 msgs/10s) plenty of headroom. Even a household of 3-4 people on the same IP stays well under the `normal` limit. Only a coordinated multi-account spam attack would hit it.

---

## Frontend Rate Limit — Kept In Place

The existing frontend rate limit in `chatBox.tsx` (`MESSAGES_LIMIT = 1`, `LIMIT_SECONDS = 3`) stays unchanged. It fires first and handles the single-user case. The backend rate limit is a second layer that only activates when the per-IP total across all accounts exceeds the window budget.

**Current frontend rate limit UX** (stays as-is):
- `rateLimitExceeded` state disables the input and Send button
- Countdown timer shown: `"Limit reached. Retry in X seconds"`
- `<Alert severity="error">` shown above the input

**Backend rate limit UX** (new — mirrors existing frontend UX):
- Backend emits a new dedicated socket event: `server_rate_limit`
- Frontend listens for `server_rate_limit` and sets the same `rateLimitExceeded = true` + `remainingSeconds = retryAfter`
- Result: same disabled input + countdown UX the user already sees from the frontend limit
- No UI changes needed — reuses existing state and components

Using a dedicated `server_rate_limit` event (not the generic `error` event) means:
1. The frontend can trigger the exact same countdown UX rather than just showing a static error string
2. It's distinguishable from other errors (banned, room not found, etc.)

---

## Files to Change

### 1. `utils/perfomance_config.js`

Add `rateLimitMax` and `rateLimitWindowSeconds` to each mode's settings object, and expose them via `getCurrentPerformanceMode()`.

**What changes:**
```js
// Add to each mode in performanceMode.settings:
normal:  { ..., rateLimitMax: 15, rateLimitWindowSeconds: 10 }
peak:    { ..., rateLimitMax: 10, rateLimitWindowSeconds: 10 }
extreme: { ..., rateLimitMax: 5,  rateLimitWindowSeconds: 10 }

// setPerformanceMode() already handles propagation — no changes needed there
```

`getCurrentPerformanceMode().settings.rateLimitMax` and `.rateLimitWindowSeconds` are then available anywhere that imports `getCurrentPerformanceMode`.

---

### 2. `socket/socketHandler.js`

Two changes:

**A. Set IP at connection time, upgrade at `join_room`**

IP is derived from headers immediately at connection time — before any events are received. This ensures rate limiting applies even if a client skips `join_room` entirely and sends `room_message` directly. `socket.handshake.address` is not used — in proxied deployments it is the nginx address (`127.0.0.1`).

```js
io.on("connection", (socket) => {
  // Runs for every client regardless of what events they send after.
  // Covers the case where a malicious client skips join_room entirely.
  let connIp =
    socket.handshake.headers["x-real-ip"] ||
    socket.handshake.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    "";
  if (connIp.startsWith("::ffff:")) connIp = connIp.replace("::ffff:", "");
  socket.clientIp = connIp;
  ...
```

Then in `join_room`, upgrade to `inComingClientIp` (ipify.org) if the frontend provided it — more accurate than headers, and covers users behind CGNAT:

```js
socket.on("join_room", async (data) => {
  // Upgrade to ipify.org IP if provided. Headers already set as baseline at connect.
  if (data.inComingClientIp) {
    socket.clientIp = data.inComingClientIp;
  }
  // ... existing joinRoom() logic unchanged
});
```

**Why this order matters:**

| Scenario | IP source used |
|----------|---------------|
| Normal client sends `join_room` with `inComingClientIp` | ipify.org — most accurate |
| Normal client with adblocker (ipify.org blocked) | nginx header set at connect |
| Malicious client skips `join_room` | nginx header set at connect — still rate limited |

**B. Rate limit check in `room_message`**

Import and alias following the same convention as `roomManager.js` (`pubClient` aliased as `redis`).
Define the key prefix as a named constant at the top of the file alongside any other constants.

```js
// Top of socketHandler.js — import following roomManager.js convention
const { pubClient: redis } = require("@project/config/redis");

// Key prefix constant — follows REDIS_ROOMS_SET / REDIS_ROOM_COUNTS naming pattern
const REDIS_RATE_LIMIT_PREFIX = "ratelimit:";
```

Before broadcasting, check Redis using a **single pipeline round trip**. `EXPIRE NX` sets the TTL only if the key has none — so the window is fixed from the first message and never reset on subsequent ones.

```js
socket.on("room_message", async (data) => {
  // IP rate limit check — single pipeline round trip
  const ip = socket.clientIp;
  if (ip) {
    const { rateLimitMax, rateLimitWindowSeconds } = getCurrentPerformanceMode().settings;
    const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;

    const pipeline = redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, rateLimitWindowSeconds, "NX"); // NX = only set if key has no TTL yet
    const [count] = await pipeline.exec();

    if (count > rateLimitMax) {
      const retryAfter = await redis.ttl(key);
      socket.emit("server_rate_limit", {
        message: `Too many messages from your network. Try again in ${retryAfter}s.`,
        retryAfter,
      });
      return;
    }
  }

  // ... existing roomExists() + broadcast logic unchanged
});
```

**Why `EXPIRE NX` matters:** Without `NX`, every message would reset the TTL. A spammer sending 1 message every 9 seconds (on a 10s window) would never accumulate a count above 1 — the counter would always expire before the next message. `NX` pins the window start to the first message and never moves it.

---

### 3. `football-next-score8o8/src/components/chatBox/chatBox.tsx`

Two changes:

**A. Fetch real client IP in the connect handler and send in `join_room`**

Called directly inside `newSocket.on("connect", ...)` — awaited before emitting so every `join_room` (including reconnects) uses a fresh IP. No `useEffect` or ref needed.

```ts
newSocket.on("connect", async () => {
  const inComingClientIp = await fetchClientIp();
  newSocket.emit("join_room", {
    senderName: nameToUse,
    roomId,
    websiteName: SIMPLE_URL,
    inComingClientIp,
  });
});
```

Import: `import { fetchClientIp } from "src/utils/getClientIp";`

**B. Listen for `server_rate_limit` event**

Alongside the other `newSocket.on(...)` listeners — triggers the same countdown/disabled-input UX as the existing frontend rate limit:

```ts
newSocket.on("server_rate_limit", (data: { message: string; retryAfter: number }) => {
  setRateLimitExceeded(true);
  setRemainingSeconds(data.retryAfter);
  setError(data.message);
});
```

The user sees no difference between a frontend-triggered and backend-triggered rate limit.

---

## What Does NOT Change

| Component | Status |
|-----------|--------|
| Frontend rate limit (1 msg / 3s per connection) | Unchanged — kept in place |
| All other socket event names and payloads | Unchanged |
| `room_message` broadcast logic | Unchanged — rate limit is a pre-check only |
| `join_room` success/failure flow | Unchanged — IP attachment is a side effect only |
| HTTP API routes | Unchanged |
| MongoDB models | Unchanged |
| Admin message flow (`admin_room_message`) | Unchanged — admins are not rate limited |
| Ban system | Unchanged |
| Performance mode levels and all other settings | Unchanged |

---

## Redis Key Design

| Key | Type | TTL | Contains |
|-----|------|-----|----------|
| `ratelimit:{ip}` | String (counter) | `rateLimitWindowSeconds` (auto-expires) | Message count for this IP in current window |

Keys expire automatically — no cleanup needed. On server restart the counters reset (acceptable, not a security issue).

---

## Inspecting Rate Limit State

```bash
# See all active rate limit keys
redis-cli KEYS "ratelimit:*"

# Check a specific IP's current count and TTL
redis-cli GET "ratelimit:45.84.136.240"
redis-cli TTL "ratelimit:45.84.136.240"
```

---

## Layer Summary

```
User sends message
      │
      ▼
[Frontend] 1 msg / 3s per connection  ← existing, unchanged
      │ passes
      ▼
[Backend] N msgs / 10s per IP across all accounts and all processes
      │ passes
      ▼
Message broadcast to room
```

The backend layer is the one that stops multi-account same-IP spam. The frontend layer stays as the first line of defense for the normal single-user case.
