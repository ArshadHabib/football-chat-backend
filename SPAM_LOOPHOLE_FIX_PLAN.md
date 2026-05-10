# Multi-Account Spam Loophole — Fix Plan

## Deployment Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1.1 — Drop `inComingClientIp` from security decisions | ✅ **Deployed** | Backend now uses `req.ip` (HTTP) and nginx-forwarded `X-Real-IP` / `X-Forwarded-For` (sockets) only. See [Phase 1.1 — Status](#phase-11--deployed-summary) below. |
| 1.2 — Enable `socket.senderName` ban-check fix | Pending | Code already prepared, two lines to uncomment |
| 1.3 — Re-enable ban check on `join_room` | Pending | Code already prepared, uncomment block |
| 2.1 — Port FE heuristics to backend `utils/messageValidation.js` | ✅ **Deployed** | All FE validators (URL, leet, all-caps, repeated phrase, fuzzy duplicate, length cap) run server-side now. See [Phase 2 — Status](#phase-2--deployed-summary) below. |
| 2.2 — Hook validator into `room_message` (drop-only) | ✅ **Deployed** | Invalid messages dropped silently. Per-socket ring buffer feeds fuzzy-duplicate check. |
| 2.3 — Strike counter + auto-ban | Pending | Will be added on top of validation later. |
| 2.4 — Admin feature flags: New User Registration + Validate Each Message | ✅ **Deployed** | Cluster-wide, Redis-persisted toggles via admin UI. See [Phase 2.4 — Deployed Summary](#phase-24--deployed-summary). |
| 2.5 — Profanity parity with FE (`bad-words` `cleanString` for messages) | ✅ **Deployed** | Messages censored before broadcast/persist. Username `isProfane` check intentionally NOT enforced server-side — FE-only. See [Phase 2.5 — Profanity parity](#phase-25--profanity-parity-with-fe-bad-words-filter). |
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

### Phase 2 — Deployed Summary

**Status:** ✅ 2.1 + 2.2 deployed (validation + drop). Strike counter + auto-ban (originally drafted as 2.3) intentionally **not** deployed yet — will be added on top of this baseline once we see how often validation fires in production logs.

The frontend heuristics now run on the server too. A bot that connects directly to socket.io and skips the React layer hits the same checks. Invalid messages are **dropped silently** — broadcast is skipped, no `error` event emitted to the client, no Mongo write. Behaviour for legitimate clients is unchanged.

#### Files shipped

| File | Change |
|------|--------|
| `utils/messageValidation.js` | New — pure JS port of FE `messageValidation.ts` + `checkUrls.ts` (URL detection inlined to avoid `url-regex-safe` dep). Exports `validateMessage(content, recentMessages)`. |
| `socket/socketHandler.js` | Imports `validateMessage`. Wires it into `room_message` handler after the ban/rate-limit pipeline. Adds per-socket `recentMessages` ring buffer (size 5) feeding fuzzy-duplicate detection. Invalid → `return` (drop silently). |

#### Validation pipeline (in `room_message` handler)

```
1. Ban check + room exists + per-IP rate limit  ← already existed (Phase 1)
2. validateMessage(content, socket.recentMessages)
   - length > 200 chars                         → drop
   - containsUrls                               → drop
   - checkBotSuffix / checkAllCaps              → drop
   - checkExcessivePunctuation                  → drop
   - checkRepeatedPhrase (post leet-normalize)  → drop
   - 5+ repeated chars / repeating words        → drop
   - checkFuzzyDuplicate vs last 5 from socket  → drop
3. Push normalized message into socket.recentMessages (ring buffer of 5)
4. Broadcast + persist
```

Drops are **silent** — no `error` event emitted to the client. Bots get no feedback to tune against.

#### Why per-socket recent buffer is sufficient

In PM2 cluster mode, a single socket connection lives on exactly one worker for its lifetime. Every `room_message` from that socket fires on the same worker, so `socket.recentMessages` (in-memory on the socket object) is the right scope for fuzzy-duplicate detection. Cross-process state would only matter for broadcasts, which Socket.io's Redis adapter already handles.

A bot that cycles sockets per message defeats this per-socket buffer — that case will be addressed when 2.3 (strike counter keyed by real IP, surviving reconnects) is added.

#### Tunable parameters

| Constant | Default | Where | Effect |
|----------|---------|-------|--------|
| `RECENT_MESSAGES_BUFFER` | 5 | `socket/socketHandler.js` | Last N normalized messages used for fuzzy-duplicate check |
| `MAX_LENGTH` | 200 | `utils/messageValidation.js` | Max chars per message |

#### Phase 2.3 (deferred) — Strike Counter + Auto-Ban

When ready, add on top of the current code:

1. Constants in `utils/const_config.js`: `STRIKE_USER_PREFIX`, `STRIKE_IP_PREFIX`, `STRIKE_THRESHOLD = 5`, `STRIKE_WINDOW_SECONDS = 60`.
2. Service helper in `modules/user/service.js`: `autoBanForSpam(username, ipAddress)` — flips Mongo flag, cascades to siblings via existing `banAllUsersByIp`, returns merged banned-name list.
3. Module-level helpers in `socket/socketHandler.js`:
   - `recordStrike(username, ip)` — pipeline of INCR + EXPIRE NX on `strikes:user:{name}` and `strikes:ip:{ip}`. Returns `true` iff either counter reached threshold on this call (strict equality, atomic).
   - `applyAutoBan(socket, username)` — runs `autoBanForSpam`, syncs `__banned_users__` + `__banned_ips__` Redis sets, calls `broadcastBanToAllRooms`, disconnects offending socket.
4. In the `room_message` validation block, replace `if (!verdict.ok) return;` with:
   ```js
   if (!verdict.ok) {
     const crossed = await recordStrike(senderName, ip);
     if (crossed) await applyAutoBan(socket, senderName);
     return;
   }
   ```
5. Imports: re-add `BANNED_IPS_KEY` + strike constants from `const_config`, `autoBanForSpam` from `user/service`, `broadcastBanToAllRooms` from `roomManager`.

#### Phase 2.5 — Profanity parity with FE (`bad-words` filter)

**Status:** ✅ Deployed for chat messages only. The server now mirrors the FE's `cleanString` call site for `room_message`. The username `checkOffensiveWords` gate is **intentionally not enforced server-side** — kept at the FE only (see "Intentionally NOT done" below).

**FE call sites being mirrored:**
- [chatBox.tsx handleSendMessage](football-next-score8o8/src/components/chatBox/chatBox.tsx#L174) — wraps every outgoing message in `cleanString(inputValue)` before emitting. **Mirrored on server.**
- [chatBox.tsx handleRegister](football-next-score8o8/src/components/chatBox/chatBox.tsx#L1315) — rejects registration if `checkOffensiveWords(username)` is true. **Not mirrored on server** — see below.

A bot connecting directly to socket.io would otherwise bypass the message-cleaning step and send raw profanity into broadcasts. The server now blocks that.

**Files shipped:**

| File | Change |
|------|--------|
| `package.json` | Added `bad-words: ^3.0.4` — pinned to v3 because v4+ is ESM-only and the chat-backend is CommonJS (`require("bad-words")` of v4 throws `ERR_REQUIRE_ESM`). v3 is the last CJS release; runtime API (`Filter.clean`, `Filter.isProfane`) is identical to v4, so server behaviour matches the FE which uses v4. **Do not bump to v4** without first migrating this project to ESM. |
| `utils/messageValidation.js` | `const Filter = require("bad-words")` — v3 default-exports the class (not a named export). Instantiated a single shared `profanityFilter` at module load. Added `cleanString(text)` and `isProfane(text)` exports with try/catch fallbacks (the lib throws on certain unicode edge cases — fall back to passing the raw string rather than dropping a message because of a library quirk). `validateMessage` return shape extended: when `ok: true`, also returns `cleaned` (the censored content the caller should broadcast). |
| `socket/socketHandler.js` | `room_message` handler now resolves `outputContent` for both broadcast and Mongo persistence — `verdict.cleaned` when validation flag is on, raw `messageContent` when off. Cleaning is gated on `FEATURE_VALIDATION` (same toggle as heuristic drops): admin's "Validate Each Message" switch controls censoring **and** drops together. |

**Single toggle gates both cleaning and heuristic drops:**

```
[room_message handler]
       │
       ▼
[FEATURE_VALIDATION flag]
       │
       ├── ON  → validateMessage runs → heuristic drops + cleanString censoring
       │            │ ok? → outputContent = verdict.cleaned
       │            │ else → drop silently (return)
       │
       └── OFF → outputContent = raw messageContent (no drops, no cleaning)
       │
       ▼
Broadcast + persist outputContent
```

**Rationale for gating both together:**

When the admin flips "Validate Each Message" to OFF, the intent is "the server stops touching message content." All server-side message processing (heuristic drops AND profanity censoring) suspends together. When ON, both run as a unit. The FE still cleans on its own send path regardless — so legitimate browser users always see censored output via the FE call. The server-side toggle is purely for the bot bypass case, and the operator wants a single switch for "is the server in defensive mode or pass-through mode."

**Persistence note:** the cleaned content is also stored in MongoDB (the `saveChatMessageService` call). When message history is loaded later via `fetchChatMessages` it will display the same censored text the room saw live — no divergence between live broadcast and history.

**What was intentionally NOT done in 2.5:**

- **No `isProfane(username)` check in `/register-user`** — the FE rejects profane usernames in `handleRegister`, but the server does not. Reasoning: usernames are visible in chat where messages would be cleaned anyway, the cost of getting a name wrong (rejecting a legitimate user with an unusual name) is higher than for messages, and the FE filter already catches the common case. `isProfane` is still exported from `utils/messageValidation.js` so the check is one line away if we want to enforce it later.
- No locale-aware filtering — `bad-words` ships with an English wordlist only. Spammers using non-English profanity will not be censored. Acceptable for the current audience; revisit if the audience widens.
- No custom wordlist additions — using `bad-words` defaults. If specific terms repeatedly slip through, `profanityFilter.addWords(...)` can be called once at module load.

#### What was intentionally NOT done in 2.1/2.2

- No `url-regex-safe` dep — inlined a focused URL regex covering `http(s)://`, `www.`, and common TLDs. Sufficient for the threat model.
- No strike counter or auto-ban — deferred to 2.3 so we can tune validation alone first based on real traffic logs and confirm no false-positive drops on legitimate users.

---

### Phase 2.4 — Deployed Summary

**Status:** ✅ Deployed. Two cluster-wide admin feature flags exposed in the football-admin matches view, alongside the existing Chat Server Mode radio group:

| Toggle | Default | When ON | When OFF |
|--------|---------|---------|----------|
| **New User Registration** | ON | `/register-user` works as normal | `/register-user` returns 403 "New user registration is currently disabled." Existing users keep chatting; only new account creation is blocked. |
| **Validate Each Message** | OFF | `room_message` runs the full server-side heuristic suite from Phase 2.1; invalid messages dropped silently | `room_message` skips validation entirely; messages broadcast as-is (Phase 2.1 + 2.2 effectively becomes a no-op until flipped on). |

#### Why this exists

- **Registration kill-switch** — when a wave is in progress and we see a flood of new accounts, admin can stop the bleeding instantly without restarting the chat backend or pushing code.
- **Validation kill-switch** — content heuristics start OFF so Phase 2.1/2.2 can be deployed safely without immediately affecting live traffic. Admin flips it on the moment a wave starts and off when it ends, or leaves it on permanently once we've confirmed no false-positives in production logs.
- Both flags act on every PM2 instance simultaneously without restart.

#### Architecture — Redis-persisted, pub/sub-propagated

Mirrors the `__perf_mode__` pattern but adds **Redis persistence** to fix a known weakness in that pattern: a PM2 worker that crashes and restarts in `__perf_mode__` boots back to `normal` regardless of cluster state, silently diverging until the next admin click. Feature flags avoid that — every worker hydrates from Redis at boot, so a restart never desyncs.

```
Admin UI clicks "Validate Each Message" → ON
    │ POST /api/next/match/set-feature-flag  { name: "validation", value: true }
    ▼
[football-backend admin route]                modules/match/index.js (isAdmin + isUserLoggedIn)
    │ setFeatureFlagApiCall(name, value)
    ▼
[football-chat-backend route]                 modules/chat/index.js (isAdminKeyCorrect)
    │ setFeatureFlagController →
    ▼
[utils/feature_flags.js setFlag]
    │ 1. applyFlag(name, value)               ← updates THIS instance's in-memory cache
    │ 2. SET feature:{name} "true"            ← Redis persistence (survives restart)
    │ 3. PUBLISH __feature_change__           ← cross-instance fan-out
    ▼
[All 5 PM2 instances — including originator]  server.js featuresSubClient.subscribe
    │ JSON.parse → applyFlag(name, value)     ← updates each instance's cache
    ▼
Next read of getFlag(name) returns the new value, ~1ms after the admin click.
```

#### Why a separate `featuresSubClient`

[config/redis.js](football-chat-backend/config/redis.js) now creates four Redis connections:

| Client | Purpose |
|--------|---------|
| `pubClient` | All non-pub/sub Redis ops + outbound PUBLISH |
| `subClient` | Socket.io adapter (cross-process broadcasts) |
| `perfSubClient` | Subscribed to `__perf_mode__` |
| `featuresSubClient` | Subscribed to `__feature_change__` |

A Redis client in subscribed mode can only receive — separating concerns by channel keeps each subscriber independent and makes future channels trivial to add.

#### Files shipped — football-chat-backend

| File | Change |
|------|--------|
| `utils/feature_flags.js` | New — in-memory cache, `loadFromRedis()`, `subscribeToChanges()`, `setFlag()`, `getFlag()`, `getAllFlags()`. Defaults: `registration: true`, `validation: false`. |
| `config/redis.js` | Added `featuresSubClient` + connect on startup. |
| `server.js` | `await featureFlags.loadFromRedis()` + `await featureFlags.subscribeToChanges()` in startup sequence, before `warmBanCaches` so flags are correct from request #1. |
| `modules/chat/controller.js` | New `setFeatureFlagController` (validates `name: string`, `value: boolean`) and `getFeatureFlagsController`. |
| `modules/chat/index.js` | New routes `POST /set-feature-flag` and `POST /get-feature-flags` (both `isAdminKeyCorrect`). |
| `modules/user/controller.js` | `registerUserController` short-circuits with 403 when `getFlag(FEATURE_REGISTRATION)` is false. |
| `socket/socketHandler.js` | `room_message` validation block wrapped in `if (getFlag(FEATURE_VALIDATION))`. |

#### Files shipped — football-backend (proxy)

| File | Change |
|------|--------|
| `utils/socket_apis_endpoints.js` | Added `setFeatureFlag` + `getFeatureFlags` URLs targeting the chat backend. |
| `utils/socket_api_calls.js` | Added `setFeatureFlagApiCall(name, value)` and `getFeatureFlagsApiCall()` with `ADMIN_KEY` baked in. |
| `modules/match/controller.js` | Added `setFeatureFlagController` and `getFeatureFlagsController`. |
| `modules/match/index.js` | New routes `POST /set-feature-flag` and `GET /get-feature-flags` (both `isAdmin + isUserLoggedIn`). |

#### Files shipped — football-admin (UI)

| File | Change |
|------|--------|
| `src/utils/axios.ts` | Added `setFeatureFlag` and `getFeatureFlags` to `endpoints.matches`. |
| `src/sections/matches/view/matches-list-view.tsx` | Imported `Switch`. Added `featureFlags` state initialised to `{ registration: null, validation: null }` (switches render disabled until first fetch). Added `getFeatureFlags()` callback called alongside `getChatPerformanceMode()` on mount. Added `handleFeatureFlagChange(name, value)` with optimistic update + snackbar + rollback on error. Added two `Switch` controls in the existing Chat Server Mode row labeled "New User Registration" and "Validate Each Message". |

#### Redis key + channel design

| Key / Channel | Purpose | Lifetime |
|---------------|---------|----------|
| `feature:registration` | Persisted flag value (`"true"` or `"false"`) | Permanent (until manually deleted) |
| `feature:validation` | Persisted flag value (`"true"` or `"false"`) | Permanent |
| `__feature_change__` | Pub/sub channel for cross-instance updates | Transient (Redis pub/sub doesn't persist) |

On first cluster boot, `loadFromRedis()` finds both keys absent and seeds them with the defaults — so subsequent reads are deterministic and the admin UI sees a complete state on first load.

#### Key design property — restart safety

| Scenario | Outcome |
|----------|---------|
| Admin sets validation ON → 1 instance crashes → PM2 respawns it | Respawned instance reads `feature:validation = "true"` from Redis at startup. Validation enforced from request #1. ✅ |
| Admin sets validation ON → all 5 instances restart simultaneously (deploy) | Every instance hydrates from Redis. State is preserved across the deploy. ✅ |
| Redis is wiped or cluster is brand new | `loadFromRedis()` finds keys absent, seeds defaults (`registration: true`, `validation: false`), state is consistent across all instances. ✅ |
| Admin toggles flag while one instance has lost its Redis connection | The disconnected instance won't see the publish — but the flag is also persisted, so on reconnect it could re-hydrate. Currently it doesn't auto-rehydrate (only at boot). Acceptable: Redis blips are rare and the next instance restart syncs. Future work: re-call `loadFromRedis()` on `pubClient.on("ready")`, mirroring the `warmBanCaches` reconnect pattern in `server.js`. |

#### What was intentionally NOT done

- **No persistence of perf mode** — `__perf_mode__` still resets to `normal` on instance crash. That existing weakness was deliberately left alone in this phase to keep the diff focused. Same fix applies if/when wanted: `SET perf_mode <mode>` before `PUBLISH`, hydrate at startup.
- **No re-hydrate on Redis reconnect** — flags don't auto-resync if an instance loses Redis mid-session. See edge case in the table above. Add later if monitoring shows the issue.
- **No per-flag audit log** — admin actions aren't recorded anywhere except logs (`console.log` in the API call wrappers). If you need an audit trail, write to an `admin_audit` Mongo collection inside `setFlag()`.

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
| 2.1 — server-side validation | ✅ Deployed | ~2 hr | Heuristics run regardless of client; bots can't bypass FE checks |
| 2.2 — wire validation into `room_message` (drop-only) | ✅ Deployed | ~30 min | Invalid messages dropped silently; broadcast skipped |
| 2.3 — strike counter + auto-ban | Pending | ~1 hr | Wave self-extinguishes without admin action |
| 2.4 — admin feature flags (registration / validation) | ✅ Deployed | ~2 hr | Cluster-wide kill-switches: flip registration off mid-wave; flip validation on/off without restart |
| 2.5 — `bad-words` parity (cleanString on messages) | ✅ Deployed | ~30 min | Profanity censored before broadcast/persist. Username `isProfane` not enforced server-side (FE only). |
| 3.1 — CAPTCHA | Pending | ~half day | Future waves cannot scale account creation |
| 3.3 — connection cap | Pending | ~30 min | One real IP cannot hold hundreds of sockets |
| 4.1 — hash-spam detector | Pending | ~2 hr | Coordinated copy-paste detected automatically |
| 4.2 — admin panic actions | Pending | ~half day | Manual override available during incidents |

**Currently deployed:** Phase 1.1 + 2.1 + 2.2 + 2.4 + 2.5 — IP-based defenses work against the real client IP, FE heuristics run server-side with invalid messages dropped silently, message profanity is censored before broadcast/persist when validation is on, and admin has cluster-wide kill-switches for both new-user registration and per-message validation. Cleaning + heuristic drops gate together on the validation toggle. Username profanity check stays FE-only.

**Next minimal hardening:** Phase 1.2 + 1.3 (5 min each — closes username-spoof bypass and disconnects banned accounts at join) followed by Phase 2.3 (~1 hr — turns repeat violations into auto-bans so admins don't have to chase waves manually).

---

## Layer Summary After Fix

```
Real client IP (from nginx x-real-ip / x-forwarded-for, never client body)
      │
      ▼
[FEATURE_REGISTRATION flag]                       ← Phase 2.4 (admin kill-switch, default ON)
      │ ON → continue;  OFF → 403
      ▼
[CAPTCHA on /register-user]                       ← Phase 3.1
      │ passes
      ▼
[Registration rate limit] 1 acct / 10 min / IP    ← already exists, works after Phase 1.1
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
[Backend rate limit] 1 msg / 5 s / IP             ← already exists, works after Phase 1.1
      │ passes
      ▼
[FEATURE_VALIDATION flag]                         ← Phase 2.4 (admin kill-switch, default OFF)
      │ ON → run heuristics + cleanString
      │ OFF → skip everything, broadcast raw content
      ▼
[Server-side message validation] heuristics       ← Phase 2.1 + 2.2 (deployed: drop-only)
      │ passes (else: strike counter → auto-ban)  ← Phase 2.3 (deferred)
      ▼
[cleanString — profanity censoring]               ← Phase 2.5 (gated on validation toggle)
      │
      ▼
[Hash-of-payload spam detector]                   ← Phase 4.1
      │ passes
      ▼
Message broadcast to room + persist to MongoDB
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

### Phase 1.1 — ✅ Deployed
| File | Change |
|------|--------|
| `middleware/index.js` | (no change — `attachClientIp` already correct) |
| `modules/user/controller.js` | Stop reading `inComingClientIp`; use `req.body.clientIp` (set by `attachClientIp` from `req.ip`) |
| `socket/socketHandler.js` | Remove `inComingClientIp` override on `join_room`; rely on connection-time IP from `x-real-ip` / `x-forwarded-for` |

### Phase 1.2 + 1.3 — Pending
| File | Change |
|------|--------|
| `socket/socketHandler.js` | Uncomment `socket.senderName = senderName;` at join; switch ban-check pipeline to `socket.senderName ?? senderName`; uncomment join-time ban check block |

### Phase 2.1 + 2.2 — ✅ Deployed
| File | Change |
|------|--------|
| `utils/messageValidation.js` | New — server-side port of FE heuristics (`normalizeLeetspeak`, `checkBotSuffix`, `checkAllCaps`, `checkExcessivePunctuation`, `checkRepeatedPhrase`, `checkFuzzyDuplicate`, inlined `containsUrls`, 200-char cap). Exports `validateMessage(content, recentMessages)`. |
| `socket/socketHandler.js` | Imports `validateMessage`. Adds `RECENT_MESSAGES_BUFFER = 5`. After ban/rate-limit pipeline, calls `validateMessage` against per-socket `recentMessages` ring buffer; on failure, drops silently (`return`) without strike or error emit. |

No new dependencies added — `bad-words` and `url-regex-safe` were intentionally skipped. Inlined URL regex covers the threat model; current spam pattern is caught by length / all-caps / repeated-phrase / repeated-char heuristics.

### Phase 2.3 — Pending (recipe in [Phase 2.3 (deferred) — Strike Counter + Auto-Ban](#phase-23-deferred--strike-counter--auto-ban))
| File | Change |
|------|--------|
| `utils/const_config.js` | Add `STRIKE_USER_PREFIX`, `STRIKE_IP_PREFIX`, `STRIKE_THRESHOLD`, `STRIKE_WINDOW_SECONDS` |
| `modules/user/service.js` | Add `autoBanForSpam(username, ipAddress)` helper |
| `socket/socketHandler.js` | Add `recordStrike()` + `applyAutoBan()` helpers; wire into validation drop branch |

### Phase 2.4 — ✅ Deployed (admin feature flags)

**football-chat-backend:**
| File | Change |
|------|--------|
| `utils/feature_flags.js` | New module — Redis-persisted flags, in-memory cache, pub/sub propagation |
| `config/redis.js` | Added `featuresSubClient` |
| `server.js` | Hydrate flags + subscribe to `__feature_change__` at startup |
| `modules/chat/controller.js` | Added `setFeatureFlagController` + `getFeatureFlagsController` |
| `modules/chat/index.js` | Routes `POST /set-feature-flag`, `POST /get-feature-flags` (`isAdminKeyCorrect`) |
| `modules/user/controller.js` | Gate `registerUserController` on `FEATURE_REGISTRATION` |
| `socket/socketHandler.js` | Wrap `room_message` validation block in `if (getFlag(FEATURE_VALIDATION))` |

**football-backend:**
| File | Change |
|------|--------|
| `utils/socket_apis_endpoints.js` | Added `setFeatureFlag` + `getFeatureFlags` URLs |
| `utils/socket_api_calls.js` | Added `setFeatureFlagApiCall` + `getFeatureFlagsApiCall` |
| `modules/match/controller.js` | Added `setFeatureFlagController` + `getFeatureFlagsController` |
| `modules/match/index.js` | Routes `POST /set-feature-flag`, `GET /get-feature-flags` (`isAdmin + isUserLoggedIn`) |

**football-admin:**
| File | Change |
|------|--------|
| `src/utils/axios.ts` | `endpoints.matches.setFeatureFlag` + `getFeatureFlags` |
| `src/sections/matches/view/matches-list-view.tsx` | `featureFlags` state, `getFeatureFlags()` callback, `handleFeatureFlagChange()` with optimistic update + rollback, two `Switch` controls beside Chat Server Mode |

### Phase 2.5 — ✅ Deployed (`bad-words` parity for messages only)

| File | Change |
|------|--------|
| `package.json` | Added `bad-words: ^3.0.4` (v3 is last CJS release; v4+ is ESM-only and would break `require()`). FE uses v4 — runtime API is the same |
| `utils/messageValidation.js` | New `cleanString` and `isProfane` exports; shared `Filter` instance; `validateMessage` now returns `cleaned` alongside `normalized` |
| `socket/socketHandler.js` | `room_message` resolves `outputContent` (`verdict.cleaned` if validation flag on, raw `messageContent` if off) and uses it for both broadcast and Mongo persistence. Cleaning gated on the same `FEATURE_VALIDATION` toggle as the heuristic drops. |
| `modules/user/controller.js` | (No change — username `isProfane` gate intentionally kept FE-only) |

### Phase 3 — Pending
| File | Change |
|------|--------|
| `modules/user/controller.js` | Add CAPTCHA verification step before `createUser` |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Add CAPTCHA widget on registration form |
| `socket/socketHandler.js` | Add per-IP concurrent connection cap |
| `utils/const_config.js` | Add `MAX_CONCURRENT_PER_IP` |

### Phase 4 — Pending
| File | Change |
|------|--------|
| `socket/socketHandler.js` | Hash-of-payload tracking after validation passes |
| `modules/chat/controller.js` (or new admin module) | Panic action endpoints |

### Frontend cleanup — Optional, Pending (not security-relevant)
| File | Change |
|------|--------|
| `football-next-score8o8/src/utils/registerChatUser.ts` | Remove `fetchClientIp()` call and `inComingClientIp` body field |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Remove `fetchClientIp()` call in `connect` handler |
| `football-next-score8o8/src/utils/getClientIp.ts` | Delete file once both call sites are gone |
