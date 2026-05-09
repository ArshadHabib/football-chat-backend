# Multi-Account Spam Loophole — Fix Plan

## Deployment Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1.1 — Drop `inComingClientIp` from security decisions | ✅ **Deployed** | Backend now uses `req.ip` (HTTP) and nginx-forwarded `X-Real-IP` / `X-Forwarded-For` (sockets) only. See [Phase 1.1 — Status](#phase-11--deployed-summary) below. |
| 1.2 — Enable `socket.senderName` ban-check fix | Pending | Code already prepared, two lines to uncomment |
| 1.3 — Re-enable ban check on `join_room` | Pending | Code already prepared, uncomment block |
| 2.x — Server-side message validation | Pending | |
| 3.x — CAPTCHA + connection cap | Pending | |
| 4.x — Hash-spam detector + admin panic actions | Pending | |

---

## Problem

A spammer has bypassed every IP-based defense in the system and is flooding chat from a rotating pool of accounts (`CRACKER2`, `CRACKER7`, `CRACKER15`, `CRACKER33`, `CRACKER39`, `CRCKER19`, `CRCKER24`, `HONKEY44`, `WHITERAS30`, `WHITERAS41`, `WHITERAS43`, `WHTRASH97M`, …). Each account has a different `ipAddress` in the `chatusers` collection. Messages arrive ~1/sec per account, ~10–15/sec aggregate, far above the configured 1 msg / 5 s per IP.

Sample MongoDB records (different IPs per account):

```
WHITERAS30  → 194.31.52.201
WHITERAS43  → 43.207.145.115
HONKEY44    → 202.62.52.120
CRACKER2    → 193.25.215.182
```

The configured defenses (frontend heuristics, server rate limit, IP ban, registration rate limit) are all live but produce no effect. Why is documented below.

---

## Root Cause: Client-Supplied `inComingClientIp` is Trusted Server-Side

The frontend fetches the public IP from `ipify.org` and sends it to the backend in the **request body** (`registerChatUser`) and the **`join_room` socket payload** (`chatBox.tsx`). The backend then uses that value as the IP for every IP-based decision.

| Location | Use of `inComingClientIp` |
|----------|---------------------------|
| `modules/user/controller.js:10` | Stored as `user.ipAddress` and used as the registration rate-limit key (`reg_ratelimit:{ip}`) |
| `modules/user/controller.js:14` | Looked up against `__banned_ips__` — IP ban check |
| `socket/socketHandler.js:225-227` | Overrides `socket.clientIp` (the header-derived IP) on `join_room` |
| `socket/socketHandler.js:284` | Used as the message rate-limit key (`ratelimit:{ip}`) |

A scripted client can put **any string** in `inComingClientIp`. That single field defeats every IP-based control simultaneously:

- **Registration rate limit bypassed** — fresh fake IP per call → `reg_ratelimit:{ip}` is always a new key → unlimited account creation per real machine.
- **Message rate limit bypassed** — each socket sends a different `inComingClientIp` → `ratelimit:{ip}` is unique per "user" → 1 msg / 5 s is enforced **per fake IP** instead of per real client.
- **IP ban bypassed** — `__banned_ips__` only matches the spoofed value; the spammer's other accounts have other spoofed values and stay unbanned.
- **Cascade IP ban (`banAllUsersByIp`) catches one record only** — every account has a different fake IP in MongoDB, so banning one user finds zero matching siblings.
- **Real client IP never recorded** — `user.ipAddress` is whatever the client said. No retroactive tracing possible.

The pattern in the live spam (rotating usernames, near-identical payloads, ~1 msg/sec each, all bypassing the 5 s/IP limit) fits a script that registers fresh accounts in a loop with random `inComingClientIp` values and connects directly to socket.io.

---

## Secondary Problems Compounding the Damage

### 1. Server-side has no content validation

Every anti-spam heuristic — leet-speak normalization, repeated-phrase, all-caps, excessive punctuation, URL detection, fuzzy duplicate, bad-words filter, 200-char cap — lives in `chatBox.tsx` (`handleSendMessage`). A bot connects directly to socket.io and skips the React layer entirely. The backend `room_message` handler runs only ban check + rate limit, then broadcasts.

### 2. `senderName` in `room_message` is client-supplied

The server checks `__banned_users__` against `data.senderName` from the payload. A banned user can put any name in the payload and pass the check. The fix (`socket.senderName` set at `join_room`) is already implemented in `socketHandler.js` but **commented out** at line 254 and the read site at line 281.

### 3. Ban check on `join_room` is disabled

Code is commented out at `socketHandler.js:233-248`. Banned accounts can stay connected, hold socket slots, and keep retrying. They are silenced at `room_message` only.

### 4. No connection-level limit per real IP

A single machine can hold hundreds of sockets — there is no cap on concurrent connections from the same source.

---

## Fix Plan

### Phase 1 — Stop the Bleeding (Highest Impact, Smallest Diff)

#### 1.1 — Deployed Summary

**Status:** ✅ Deployed.

The backend no longer reads `inComingClientIp` for any security decision. `req.ip` (HTTP, derived by Express from `X-Forwarded-For` under `app.set("trust proxy", 1)`) and `socket.handshake.headers["x-real-ip"]` (WebSocket) are the only sources.

**Changes shipped:**

| File | Change | Type |
|------|--------|------|
| `modules/user/controller.js:8-15` | `inComingClientIp` destructure removed; `const ip = clientIp;` replaces `const ip = inComingClientIp \|\| clientIp;` | Commented out + replaced |
| `socket/socketHandler.js:225-233` | `if (data.inComingClientIp) { socket.clientIp = ... }` override removed | Commented out |

The frontend can keep sending `inComingClientIp` in the payload — the backend silently ignores it. FE cleanup (`fetchClientIp()` call, `getClientIp.ts` deletion) is optional and not security-relevant.

**Why this works behind nginx + PM2 cluster mode:**

- nginx config sets `proxy_set_header X-Real-IP $remote_addr` and `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`. The latter expands to `<existing XFF>, <real client IP>` — the real IP is **appended** at the right.
- `app.set("trust proxy", 1)` tells Express to trust the immediate downstream proxy (nginx on `127.0.0.1`). Express walks the chain right-to-left and returns the first non-trusted IP, which is whatever nginx put there.
- Client-spoofed `X-Forwarded-For` headers don't shift the result — nginx appends after them, and trust-proxy stops at nginx's appended value.
- PM2 cluster doesn't affect IP forwarding — workers all see `127.0.0.1` as the connection peer regardless, then read the headers nginx set.

**Trust-proxy walk-through:**

| Scenario | Chain (XFF + connection IP) | `req.ip` |
|----------|----------------------------|----------|
| Honest client | `[1.2.3.4, 127.0.0.1]` | `1.2.3.4` |
| Attacker spoofs `X-Forwarded-For: 99.99.99.99` | `[99.99.99.99, 1.2.3.4, 127.0.0.1]` | `1.2.3.4` |
| Attacker sends `X-Forwarded-For: a, b, c` | `[a, b, c, 1.2.3.4, 127.0.0.1]` | `1.2.3.4` |

**Critical operational prerequisite — port 5002 must not be reachable from the public internet.**

If Node binds to `0.0.0.0:5002` and the firewall allows public access, an attacker can connect to Node directly, bypass nginx, and set arbitrary `X-Real-IP` / `X-Forwarded-For` headers — defeating this fix. Verify on the production server:

```bash
sudo ss -tlnp | grep 5002
# Expected: 127.0.0.1:5002   NOT 0.0.0.0:5002 or *:5002

sudo ufw status | grep 5002    # or: sudo iptables -L -n | grep 5002
# Expected: not open to public
```

If the listener is bound to `0.0.0.0`, harden by binding to localhost in `server.js`:

```js
server.listen(PORT, "127.0.0.1", () => { ... });
```

**Effect of 1.1:**

- Per-IP message rate limit (1 msg / 5 s, `ratelimit:{ip}` Redis key) now keys off the real client IP.
- `__banned_ips__` lookup now matches the real IP.
- `user.ipAddress` stored in MongoDB is the real IP, so `banAllUsersByIp` actually catches sibling accounts on the same source.
- Registration rate limit (1 acct / 10 min, `reg_ratelimit:{ip}`) now keys off the real IP.

**Verification step (post-deploy):**

Tail logs for ~1 minute and confirm `req.ip` and `socket.handshake.headers["x-real-ip"]` show real public IPs, not `127.0.0.1` or empty strings. If `attachClientIp` is logging an empty string for live traffic, nginx is not forwarding headers correctly and the rate limiter is silently no-op (review `nginx -T | grep proxy_set_header`).

**Frontend cleanup (optional, not security-relevant):**

| File | Change |
|------|--------|
| `src/utils/registerChatUser.ts` | Remove `fetchClientIp()` call and `inComingClientIp` body field |
| `src/components/chatBox/chatBox.tsx` (`connect` handler) | Remove `fetchClientIp()` call and `inComingClientIp` from `join_room` payload |
| `src/utils/getClientIp.ts` | Delete file once both call sites are gone |

#### 1.2 Enable the prepared `socket.senderName` fix

Already coded and commented out — uncomment two lines.

| File | Change |
|------|--------|
| `socket/socketHandler.js:254` | Uncomment `socket.senderName = senderName;` inside `join_room` |
| `socket/socketHandler.js:281` | Replace `pipeline.sIsMember(BANNED_USERS_KEY, senderName);` with `pipeline.sIsMember(BANNED_USERS_KEY, socket.senderName ?? senderName);` |

`socket.senderName` is set once at join and cannot be tampered with by the client. Sockets and their messages always live on the same process, so this works without Redis.

#### 1.3 Re-enable ban check on `join_room`

Already coded and commented out at `socket/socketHandler.js:233-248`. Uncomment the block. Banned users will be rejected at join with `{ success: false, message: "You are banned from chat." }` and the socket disconnects, freeing the slot.

The block also includes self-healing: if `isBanned: true` exists in MongoDB but is missing from `__banned_users__` (e.g., Redis was wiped), it re-adds the username on the fly.

---

### Phase 2 — Server-Side Content Validation

The frontend heuristics (`src/utils/messageValidation.ts`, `src/utils/checkOffensiveWords.ts`, `src/utils/checkUrls.ts`) must run on the server too — they currently do not.

#### 2.1 Port heuristics into the backend

Create `utils/messageValidation.js` mirroring the frontend file: `normalizeLeetspeak`, `checkBotSuffix`, `checkAllCaps`, `checkExcessivePunctuation`, `checkRepeatedPhrase`, `checkFuzzyDuplicate`, plus a single `validateMessage(content, recentMessages)` aggregator. Add `bad-words` (already used on FE) and `url-regex-safe` to the backend `package.json`.

#### 2.2 Hook validation into `room_message`

Inside the existing `room_message` handler in `socket/socketHandler.js`, after the ban + rate-limit pipeline passes:

```js
// Per-socket ring buffer of recent normalized messages (last 5)
socket.recentMessages = socket.recentMessages || [];

const verdict = validateMessage(messageContent, socket.recentMessages);
if (!verdict.ok) {
  // Drop silently — no error emit, gives bots no feedback
  recordStrike(socket);
  return;
}
socket.recentMessages = [...socket.recentMessages.slice(-4), verdict.normalized];
```

Apply length cap (200 chars) inside the same helper so all rules live in one place.

#### 2.3 Strike counter — auto-ban on repeat violations

`recordStrike(socket)` increments a Redis counter `strikes:{username}` with a short TTL (e.g., 60 s). When the count crosses a threshold (e.g., 5 in 60 s), call into the existing ban path:

```
1. updateUser(username, { isBanned: true })
2. banAllUsersByIp(socket.clientIp) — catches sibling accounts on same real IP
3. redis.sAdd(BANNED_USERS_KEY, bannedNames)
4. redis.sAdd(BANNED_IPS_KEY, socket.clientIp)
5. broadcastBanToAllRooms(bannedNames)
6. socket.disconnect()
```

This is the kill switch for content that slips past heuristics — admins no longer have to ban each new account manually during a wave.

---

### Phase 3 — Make Account Creation Expensive

Phase 1 + 2 stop the current spam. Phase 3 stops the next wave from scaling.

#### 3.1 CAPTCHA on `/register-user`

hCaptcha or Cloudflare Turnstile (both free). Frontend collects token at registration; backend verifies via the provider's `/siteverify` endpoint before calling `createUser`. Reject on failure with 403.

This alone would have stopped this run cold — the spammer's loop has no way to solve thousands of CAPTCHAs cheaply.

#### 3.2 Stable browser identifier (defense in depth)

Issue an HttpOnly signed cookie at first registration. Reject subsequent registrations from the same cookie within the existing 10-minute window even if the IP is fresh. Combined with the IP rate limit, attackers must rotate **both** cookie and IP to scale — meaningfully harder.

#### 3.3 Connection-level limit per real IP

In the `connection` block of `socket/socketHandler.js`:

```js
const concurrentKey = `socket_count:${socket.clientIp}`;
const concurrent = await redis.incr(concurrentKey);
await redis.expire(concurrentKey, 3600, "NX");
if (concurrent > MAX_CONCURRENT_PER_IP) {
  socket.emit("error", { message: "Too many connections" });
  socket.disconnect();
  return;
}
socket.on("disconnect", () => redis.decr(concurrentKey));
```

Default `MAX_CONCURRENT_PER_IP = 5`. Cheap defense against one machine fanning out hundreds of sockets behind a single IP.

---

### Phase 4 — Detection and Admin Tooling

#### 4.1 Hash-of-payload spam detector

Hash incoming message content (post-normalization). Store last-N senders per hash in Redis with a short TTL. If the same hash arrives from `>= N` distinct usernames within the window, auto-ban all senders and the hash itself. Catches coordinated copy-paste storms without any heuristic tuning.

#### 4.2 Admin panic actions

Endpoints that the admin UI can trigger during a wave:

| Action | Effect |
|--------|--------|
| `POST /admin/ban-recent-senders` | Ban all usernames that posted in the last N seconds in a given room |
| `POST /admin/ban-recent-registrations` | Ban all accounts created in the last N minutes |
| `POST /admin/lock-room` | Set a Redis flag rejecting all `room_message` for that room for N seconds |

Lets you stop a wave fast even if the auto-defenses miss the pattern.

#### 4.3 ASN/country edge filter (optional)

The IPs in this incident are residential proxies/VPS ranges in RU/JP/BR. If the audience is regional, blocking known proxy/VPS ASNs at Cloudflare or nginx cuts a large fraction of botnet traffic before it reaches Node.

---

## Recommended Deploy Order

| Phase | Status | Effort | Effect on This Spam Wave |
|-------|--------|--------|--------------------------|
| 1.1 — drop `inComingClientIp` | ✅ Deployed | ~30 min | Restores 1 msg / 5 s and IP ban for the real source IP |
| 1.2 — `socket.senderName` toggle | Pending | ~5 min | Closes the username-spoof bypass on ban check |
| 1.3 — re-enable join ban check | Pending | ~5 min | Banned accounts disconnect instead of lurking |
| 2.1 — server-side validation | Pending | ~2 hr | Heuristics run regardless of client; bots can't bypass FE checks |
| 2.3 — strike auto-ban | Pending | ~1 hr | Wave self-extinguishes without admin action |
| 3.1 — CAPTCHA | Pending | ~half day | Future waves cannot scale account creation |
| 3.3 — connection cap | Pending | ~30 min | One real IP cannot hold hundreds of sockets |
| 4.1 — hash-spam detector | Pending | ~2 hr | Coordinated copy-paste detected automatically |
| 4.2 — admin panic actions | Pending | ~half day | Manual override available during incidents |

A minimal hot-fix is **Phase 1 (1.1 + 1.2 + 1.3) + Phase 2 (2.1 + 2.2 + 2.3)** — small surface area, immediately restores all existing IP defenses, and adds the server-side enforcement that makes the FE heuristics actually matter.

---

## Layer Summary After Fix

```
Real client IP (from nginx x-real-ip / x-forwarded-for, never client body)
      │
      ▼
[CAPTCHA on /register-user]                       ← Phase 3.1
      │ passes
      ▼
[Registration rate limit] 1 acct / 10 min / IP    ← already exists, will work after Phase 1.1
      │ passes
      ▼
[Connection cap] N sockets / IP                   ← Phase 3.3
      │ passes
      ▼
[Ban check at join_room]                          ← already exists, re-enabled in Phase 1.3
      │ passes
      ▼
[Frontend validation] heuristics + 1 msg / 5 s    ← already exists
      │ passes
      ▼
[Backend ban check] socket.senderName             ← already exists, fixed in Phase 1.2
      │ passes
      ▼
[Backend rate limit] 1 msg / 5 s / IP             ← already exists, will work after Phase 1.1
      │ passes
      ▼
[Server-side message validation] heuristics       ← Phase 2.1 + 2.2
      │ passes (else strike → auto-ban after N)   ← Phase 2.3
      ▼
[Hash-of-payload spam detector]                   ← Phase 4.1
      │ passes
      ▼
Message broadcast to room
```

---

## What Does NOT Change

| Component | Status |
|-----------|--------|
| Socket event names and payload shapes (apart from removing `inComingClientIp`) | Unchanged |
| `room_message` broadcast logic | Unchanged — validation is a pre-check only |
| HTTP API routes | Unchanged |
| MongoDB models | Unchanged |
| Redis key design for ban/rate-limit | Unchanged — same keys, just keyed off real IP now |
| Admin message flow (`admin_room_message`) | Unchanged — admins are not validated or rate limited |

---

## Files Changed (Summary)

### Phase 1
| File | Change |
|------|--------|
| `middleware/index.js` | (no change — `attachClientIp` already correct) |
| `modules/user/controller.js` | Stop reading `inComingClientIp`; use `req.clientIp` everywhere |
| `socket/socketHandler.js` | Remove `inComingClientIp` override; uncomment `socket.senderName` fix; uncomment join ban check |
| `football-next-score8o8/src/utils/registerChatUser.ts` | Remove `fetchClientIp()` call |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Remove `fetchClientIp()` call in `connect` handler |
| `football-next-score8o8/src/utils/getClientIp.ts` | Delete file |

### Phase 2
| File | Change |
|------|--------|
| `utils/messageValidation.js` | New — server-side port of FE heuristics |
| `socket/socketHandler.js` | Hook `validateMessage` + `recordStrike` into `room_message` |
| `package.json` | Add `bad-words`, `url-regex-safe` |
| `utils/const_config.js` | Add `STRIKE_KEY_PREFIX`, `STRIKE_THRESHOLD`, `STRIKE_WINDOW_SECONDS` |

### Phase 3
| File | Change |
|------|--------|
| `modules/user/controller.js` | Add CAPTCHA verification step before `createUser` |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Add CAPTCHA widget on registration form |
| `socket/socketHandler.js` | Add per-IP concurrent connection cap |
| `utils/const_config.js` | Add `MAX_CONCURRENT_PER_IP` |

### Phase 4
| File | Change |
|------|--------|
| `socket/socketHandler.js` | Hash-of-payload tracking after validation passes |
| `modules/chat/controller.js` (or new admin module) | Panic action endpoints |
