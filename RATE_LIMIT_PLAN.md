# IP-Based Chat Rate Limiting — Implementation

## Problem

A single user can create multiple accounts from the same IP and use them simultaneously to spam the chat. The frontend enforces 1 message per 5 seconds **per connection**, but with 10 accounts open that becomes effectively 10 messages every 5 seconds from the same IP — bypassing the frontend limit entirely.

Example from production: IP `45.84.136.240` had 7 accounts (BALUMPIA20, BALUMPIA26, BALUMPIA30, BALUMPIA33, BALUMPIA35, BALUMPIA41, BALUMPIA49) all active at the same time.

---

## Why In-Memory Won't Work

The app runs as **5 PM2 cluster processes**. Each process has its own isolated memory. An in-memory `Map` would be per-process — if the spammer's 10 accounts are distributed across processes by nginx round-robin, each process sees only ~2 messages and the limit is never triggered.

---

## Solution: Redis INCR + EXPIRE (Shared Across All 5 Processes)

Redis is already in use for room state, socket adapter, and performance mode pub/sub. The same `pubClient` instance is reused here.

**How it works:**

```
User on IP 45.84.136.240 sends a message on any process:
  → INCR ratelimit:45.84.136.240   →  count = 1  (also SET TTL = 5s on first hit via EXPIRE NX)
  → count 1 ≤ 1  → message goes through

Another account from same IP on a different process within the same 5s window:
  → INCR ratelimit:45.84.136.240   →  count = 2
  → count 2 > 1  → BLOCKED. TTL retrieved → retryAfter sent to client
```

The counter is shared — all 5 processes increment the same Redis key. The limit is enforced globally across all accounts and all processes.

---

## Rate Limit Values

Stored in `utils/perfomance_config.js` alongside existing per-mode settings. Currently **identical across all modes**:

| Mode    | Max messages | Window |
|---------|-------------|--------|
| normal  | 1 msg       | 5s     |
| peak    | 1 msg       | 5s     |
| extreme | 1 msg       | 5s     |

`rateLimitMax: 1, rateLimitWindowSeconds: 5` — same for all three modes.

When `POST /change-server-mode` is called, the new limits propagate to all 5 processes instantly via the existing `__perf_mode__` Redis pub/sub channel — no restart needed.

---

## Frontend Rate Limit — Kept In Place

The existing frontend rate limit in `chatBox.tsx` (`MESSAGES_LIMIT = 1`, `LIMIT_SECONDS = 5`) stays in place. It fires first and handles the single-user case. The backend rate limit is a second layer that catches multi-account same-IP spam that the frontend cannot see.

**Frontend rate limit UX** (unchanged):
- `rateLimitExceeded` state disables the input and Send button
- Countdown timer shown: `"Limit reached. Retry in X seconds"`
- `<Alert severity="error">` shown above the input

**Backend rate limit UX** (mirrors frontend):
- Backend emits `server_rate_limit` socket event
- Frontend listens and sets the same `rateLimitExceeded = true` + `remainingSeconds = retryAfter`
- Same disabled input + countdown UX — user sees no difference between frontend and backend triggered limit

Using a dedicated `server_rate_limit` event (not the generic `error` event) means the frontend can trigger the exact countdown UX rather than just showing a static error string.

---

## Implementation

### `utils/perfomance_config.js`

`rateLimitMax` and `rateLimitWindowSeconds` added to each mode's settings object, available via `getCurrentPerformanceMode().settings`.

---

### `socket/socketHandler.js`

**IP set at connection time, upgraded at `join_room`:**

```js
io.on("connection", (socket) => {
  let connIp =
    socket.handshake.headers["x-real-ip"] ||
    socket.handshake.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    "";
  if (connIp.startsWith("::ffff:")) connIp = connIp.replace("::ffff:", "");
  socket.clientIp = connIp;
  ...
```

Then in `join_room`, upgraded to `inComingClientIp` (ipify.org) if provided:

```js
socket.on("join_room", async (data) => {
  if (data.inComingClientIp) {
    socket.clientIp = data.inComingClientIp;
  }
  ...
});
```

| Scenario | IP source used |
|----------|---------------|
| Normal client sends `join_room` with `inComingClientIp` | ipify.org — most accurate |
| Normal client with adblocker (ipify.org blocked) | nginx header set at connect |
| Malicious client skips `join_room` | nginx header set at connect — still rate limited |

**Ban check + rate limit in a single pipeline in `room_message`:**

```js
socket.on("room_message", async (data) => {
  const ip = socket.clientIp;
  const { rateLimitMax, rateLimitWindowSeconds } = getCurrentPerformanceMode().settings;
  const pipeline = redis.multi();
  pipeline.sIsMember(BANNED_USERS_KEY, senderName);  // results[0]
  if (ip) {
    const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;
    pipeline.incr(key);                               // results[1]
    pipeline.expire(key, rateLimitWindowSeconds, "NX");
  }
  const results = await pipeline.exec();
  const isBanned = results[0];
  if (isBanned) return;
  if (ip) {
    const count = results[1];
    if (count > rateLimitMax) {
      const retryAfter = await redis.ttl(`${REDIS_RATE_LIMIT_PREFIX}${ip}`);
      socket.emit("server_rate_limit", {
        message: `Limit reached. Retry in ${retryAfter} seconds`,
        retryAfter,
      });
      return;
    }
  }
  ...
```

**Why `EXPIRE NX` matters:** Without `NX`, every message would reset the TTL. A spammer sending 1 message every 4 seconds (on a 5s window) would never accumulate a count above 1. `NX` pins the window start to the first message and never moves it.

---

### `football-next-score8o8/src/components/chatBox/chatBox.tsx`

**Fetch real client IP in the connect handler and send in `join_room`:**

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

**Listen for `server_rate_limit` event:**

```ts
newSocket.on("server_rate_limit", (data: { message: string; retryAfter: number }) => {
  setRateLimitExceeded(true);
  setRemainingSeconds(data.retryAfter);
  setError(data.message);
});
```

---

## What Does NOT Change

| Component | Status |
|-----------|--------|
| All other socket event names and payloads | Unchanged |
| `room_message` broadcast logic | Unchanged — rate limit is a pre-check only |
| `join_room` success/failure flow | Unchanged — IP attachment is a side effect only |
| HTTP API routes | Unchanged |
| MongoDB models | Unchanged |
| Admin message flow (`admin_room_message`) | Unchanged — admins are not rate limited |
| Ban system | Unchanged |

---

## Redis Key Design

| Key | Type | TTL | Contains |
|-----|------|-----|----------|
| `ratelimit:{ip}` | String (counter) | `rateLimitWindowSeconds` seconds (auto-expires) | Message count for this IP in current window |

Keys expire automatically — no cleanup needed. On server restart the counters reset (acceptable).

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
[Frontend] 1 msg / 5s per connection  ← first line of defence
      │ passes
      ▼
[Backend] 1 msg / 5s per IP across all accounts and all processes
      │ passes
      ▼
Message broadcast to room
```
