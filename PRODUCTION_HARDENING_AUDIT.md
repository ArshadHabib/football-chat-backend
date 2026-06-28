# Chat Backend — Production Hardening Audit

**Service:** `football-chat-backend`
**Audit date:** 2026-06-28
**Scope:** Real-time chat service powering live match chat across all 12 streaming frontends (buffstreams, firstrow, 808score, halastream, dingdongsport, streampk, huba).
**Reviewer:** Architecture / code review pass over `server.js`, `socket/`, `modules/chat/`, `modules/user/`, `utils/`, `config/`, `middleware/`.

---

## 0. How to read this document

Each issue below follows the same shape so it can be triaged and ticketed independently:

- **What it is** — the technical defect, with `file:line` references.
- **Real-world scenario** — how it actually bites during a live match (e.g. a Champions League final at kickoff).
- **Impact** — who/what is affected and how badly.
- **Solution** — concrete fix, with code sketches that match the existing codebase.
- **Before → After** — behavioural and (where structurally determinable) quantitative comparison.

> **A note on numbers.** Where a number is structurally certain (e.g. "bans are 100% bypassable → 0% bypassable"), it is stated as fact. Where it is a projection (throughput, latency, memory), it is **labelled `(projected)`** and should be confirmed with a load test before being quoted externally. No benchmark in this document was measured on production; they are reasoned estimates from the code paths.
>
> **Defaults cited in this document were verified against source** on the audit date: `FEATURE_VALIDATION = false` (`utils/feature_flags.js:36`), message rate-limit `{ enabled: true, max: 1, windowSeconds: 5 }` (`utils/rate_limit_config.js:34`), registration limit 1 / 10 min (`utils/const_config.js:8`). Re-confirm these if the files have since changed, since several fixes below hinge on them.

---

## 1. Executive summary

The chat backend is **architecturally strong** — PM2 cluster + Socket.io Redis adapter + Redis-as-source-of-truth + batched writes + cached reads. It is built to handle tens of thousands of concurrent users on the hot path, and most of the hard distributed-systems work (counter drain, cross-process throttling, read-path coalescing) is already done well.

It is **not yet fully production-hardened.** There are 2 high-severity defects (one security, one input-safety), 4 medium-severity correctness/stability bugs, and 3 lower-severity hygiene items. None require an architectural rewrite — all are localized fixes.

### Scorecard

| Dimension | Today | After fixes |
|---|---|---|
| Real-time delivery design | 9 / 10 | 9 / 10 |
| Server utilization (CPU / DB / cache) | 8 / 10 | 8.5 / 10 |
| Horizontal scalability (code) | 9 / 10 | 9 / 10 |
| Deployment / availability | 4 / 10 | 7 / 10 *(after infra split)* |
| Security & abuse resistance | 4 / 10 | 8 / 10 |
| Data correctness / durability | 6 / 10 | 9 / 10 |
| **Overall production-readiness** | **6 / 10** | **8.5 / 10** |

### Issue index

| # | Severity | Issue | Primary file |
|---|---|---|---|
| 1 | 🔴 High | Ban bypass via client-supplied `senderName` (messages **and** reactions) | `socket/socketHandler.js` |
| 2 | 🔴 High | No content/size validation on socket path by default | `socket/socketHandler.js`, `server.js` |
| 3 | 🟠 Medium | `flushMessageBatch` concurrency race → message loss | `modules/chat/service.js` |
| 4 | 🟠 Medium | Drain lock deleted by wrong owner → double-counted stats | `modules/chat/service.js` |
| 5 | 🟠 Medium | `connectDB` swallows failure → worker boots broken | `config/connection.js` |
| 6 | 🟠 Medium | Per-IP rate limit throttles users behind shared NAT | `socket/socketHandler.js`, `modules/user/controller.js` |
| 7 | 🟡 Low | In-memory reaction maps leak (not purged on room delete) | `modules/chat/service.js` |
| 8 | 🟡 Low | No automated tests for concurrency-critical paths | *(repo-wide)* |
| 9 | 🟡 Low | Hardcoded `ADMIN_KEY` in source | `utils/const_config.js` |
| — | 🔵 Infra | Single co-located box = SPOF + tight memory ceiling | `ecosystem.config.js` |

---

## 2. High-severity issues

### Issue #1 — Ban bypass via client-supplied `senderName`

**What it is.** The `room_message` ban check tests the **username sent in the message payload**, not a server-verified identity:

```js
// socket/socketHandler.js:344
pipeline.sIsMember(BANNED_USERS_KEY, senderName); // senderName comes straight from the client
```

The fix is already written in the codebase but **commented out** — the socket is never bound to a verified name at join time:

```js
// socket/socketHandler.js:303-307 (currently commented)
// socket.senderName = senderName;
```

So the ban set (`__banned_users__`) only ever matches whatever string the client chooses to send.

**The same flaw exists in a second handler.** `add_reaction` also ban-checks the client-supplied payload field, not a verified identity:

```js
// socket/socketHandler.js:467
const isBanned = await redis.sIsMember(BANNED_USERS_KEY, username); // username from payload
```

And it is made worse by the fact that the **join-time ban check is intentionally disabled** (`socketHandler.js:282-301`, commented out by design — "banned users are allowed to join but cannot send messages"). That means `room_message` and `add_reaction` are the **only two enforcement points in the entire system**, and both trust client input. There is no second line of defence.

**Real-world scenario.** During a Premier League derby, a troll floods a room with abuse. An admin bans them from the [football-admin](../football-admin) panel → their name is added to `__banned_users__` and they get a `user_updated` broadcast. The troll simply edits the `senderName` field in the next socket emit (or refreshes with a new name) and keeps posting — and keeps spamming reactions the same way. From the moderator's seat, the ban "doesn't work" and they have to keep re-banning a moving target — during the exact 90 minutes when moderation matters most.

**Impact.** Moderation is effectively advisory. Any user with basic dev-tools knowledge is unbannable. The entire ban subsystem (Redis warm cache, IP cascade, `banAllUsersByIp`) is undermined by these two trusted-input lines.

**Solution.** Treat the payload `senderName`/`username` as **untrusted and stop reading them after join.** Bind the verified name to the socket once at join (validating it is a non-empty string), then use `socket.senderName` as the identity **everywhere** — the ban check, the broadcast/persisted name, and the recorded reactor. The old `?? senderName` fallback is itself a loophole (a bot that never calls `join_room` falls straight through it), so it is removed, not preserved.

```js
// 1. join_room — validate + bind the identity once (uncomment/replace socketHandler.js:307):
if (typeof senderName !== "string" || senderName.trim().length === 0) {
  return socket.emit("join_result", { success: false, message: "Invalid name" });
}
socket.senderName = senderName.trim();

// 2. room_message — require a joined, named socket; use the bound identity for the
//    ban check AND the broadcast/persist (do NOT echo data.senderName):
if (!socket.senderName || !socket.rooms.has(roomId)) return; // not joined → reject
pipeline.sIsMember(BANNED_USERS_KEY, socket.senderName);     // verified identity only
// ...when building messageData and the saveChatMessageService payload, use:
//   senderName: socket.senderName     // NOT the destructured `senderName` from data

// 3. add_reaction — same rule; the recorded reactor is the bound identity, not payload:
if (!socket.senderName) return;
const isBanned = await redis.sIsMember(BANNED_USERS_KEY, socket.senderName);
// pass socket.senderName (not data.username) into applyReactionService(...)
```

This closes **two loopholes beyond ban-evasion**: (a) **display-name impersonation** — today the broadcast and persisted record echo `data.senderName` (`socketHandler.js:417,428`), so any user can post as "Admin" or as another user even while bans "work"; (b) **reaction identity spoofing** — `add_reaction` records `data.username` into the reactor set, so user X can react *as* user Y. Both are fixed only by using `socket.senderName` as the sole identity. **All handlers must change together** — patching just the `room_message` ban check leaves both impersonation paths and the reaction ban-path open. (Once the payload name is ignored everywhere, no `data.senderName !== socket.senderName` comparison is needed — simply don't read it.)

> **Migration caution (client-side).** Requiring a joined socket means the frontend must (re)send `join_room` after **every reconnect**, before any message. Socket.io fires `connect` again on reconnect — wire the join to that event, not just to initial component mount, or post-reconnect messages will be silently dropped. Ship the client change before/with the server change.

> **Residual identity gaps (anonymous-chat model — read before assuming this is "done").** Binding `socket.senderName` stops a user from *changing* identity per message/reaction, but it does **not** stop them *picking* an impersonating name at join — including "Admin". Close the high-value case by **reserving/blocklisting privileged names** ("Admin", "Moderator", "Mod", staff handles) at *both* `register-user` and `join_room`. Full ownership proof (a user may only use a name they registered) would require per-user auth tokens — a larger change than this audit covers; track it as a known limitation, not something this fix delivers.

**Verify.** Ban a test user, then from dev-tools: (a) resend a message with a different `senderName` → dropped; (b) emit `room_message` on a socket that never sent `join_room` → dropped; (c) emit `add_reaction` with the banned name → dropped; (d) as a *non-banned* user, send a message and a reaction carrying *someone else's* name in the payload → the broadcast and the reactor record must show **your** joined name, not the spoofed one.

**Before → After.**

| | Before | After |
|---|---|---|
| Ban effectiveness vs. a determined user | ~0% (trivially bypassed) | ~100% (name fixed at connection) |
| Display-name / reaction impersonation | Possible (payload name echoed) | Blocked (bound identity) |
| Moderator effort per troll | Repeated, never sticks | One ban, permanent for that socket |
| IP-cascade ban value | Diluted (name still spoofable) | Fully effective |
| Enforcement / identity points covered | messages only, all spoofable | messages + reactions, all verified |

---

### Issue #2 — No content/size validation on the socket path by default

**What it is.** `FEATURE_VALIDATION` defaults **OFF** (`utils/feature_flags.js` DEFAULTS). When off, `room_message` broadcasts and persists the raw payload with **no length cap, no profanity filter, no URL filter**:

```js
// socket/socketHandler.js:392-405
let outputContent;
const validationOn = getFlag(FEATURE_VALIDATION);
if (validationOn) {
  // ... heuristics + cleanString ...
} else {
  outputContent = messageContent; // raw, unbounded, unfiltered
}
```

The 200-char `MAX_LENGTH` guard lives *inside* `validateMessage()` (`utils/messageValidation.js:137`), which only runs when the flag is on. Separately, Socket.io's `maxHttpBufferSize` is **not configured** in `server.js` (defaults to 1 MB), so the transport itself won't stop a large frame.

**Real-world scenario.** It's a big PPV boxing night, validation is off (the default), and a scripted client connects directly to the WebSocket — bypassing the React validators entirely. It emits a 200 KB wall of text, or a stream of betting-scam URLs, once per second. Every byte is fanned out to all 8,000 people in the room via the Redis adapter and written to MongoDB. The room becomes unusable, bandwidth spikes, and the message collection bloats — and none of the carefully-built spam heuristics fire, because they're behind a flag nobody turned on.

**Impact.** The elaborate anti-abuse layer is dormant by default. Worst case is a single client degrading a whole room and inflating storage/bandwidth. This also contradicts the repo's own `VALIDATION_SPLIT_PLAN.md`, which already proposes splitting *essential* checks (always-on) from *non-essential* heuristics (flag-gated).

**Solution.** Two cheap, independent layers:

1. **Cap the transport** in `server.js` so oversized frames never reach a handler:
   ```js
   const io = socketIo(server, {
     transports: ["websocket"],
     maxHttpBufferSize: 16 * 1024, // 16 KB — generous for chat, fatal for floods
                                   // (must clear your largest LEGIT event — e.g. admin
                                   //  update_user / admin_room_message payloads; raise if needed)
     cors: { origin: "*", methods: ["GET", "POST"] },
   });
   ```
2. **Make essential validation always-on**, per `VALIDATION_SPLIT_PLAN.md`. A type-check + trim + empty + length-cap + profanity censor run unconditionally; only the heuristic bot-detection (all-caps, leet, fuzzy-duplicate, etc.) stays behind `FEATURE_VALIDATION`. Keep `validateMessage` (which already trims, length-caps, cleans, *and* runs heuristics) for the flag-on path, and add only the essential subset for the flag-off path — so content is never double-cleaned and the `recentMessages` buffer logic is untouched:
   ```js
   // type-safe FIRST — a non-string payload (e.g. a number) must never reach .trim()
   const raw = typeof messageContent === "string" ? messageContent : "";
   const trimmed = raw.trim();
   if (!trimmed || trimmed.length > MAX_LENGTH) return; // ALWAYS — empty / oversize
   let outputContent;
   if (validationOn) {
     socket.recentMessages = socket.recentMessages || [];
     const verdict = validateMessage(trimmed, socket.recentMessages); // heuristics + clean
     if (!verdict.ok) return;
     socket.recentMessages = [
       ...socket.recentMessages.slice(-(RECENT_MESSAGES_BUFFER - 1)),
       verdict.normalized,
     ];
     outputContent = verdict.cleaned;
   } else {
     outputContent = cleanString(trimmed); // ALWAYS censor, even with heuristics off
   }
   ```
   (Apply the same `typeof` guard to `replyTo`/reply snippets — `sanitizeReplyTo` already bounds them, but the body guard above must not be the only type-safety in the handler.)

**Verify.** With `FEATURE_VALIDATION` off (the default), send a 50 KB socket message and a message containing a known profanity → the oversized frame must be rejected by the transport and the profanity must arrive censored. Confirm a normal-length message still broadcasts unchanged.

**Before → After.**

| | Before (flag off = default) | After |
|---|---|---|
| Max message size accepted | ~1 MB (transport default) | 16 KB (transport) / 200 chars (app) |
| Profanity censored | No | Yes (always) |
| Scripted flood mitigation | None until admin toggles | Length + size caps always active |
| Per-message hot-path cost | ~0 | +~5–20 µs `(projected)` for trim/length/censor |

---

## 3. Medium-severity issues

### Issue #3 — `flushMessageBatch` concurrency race → message loss under load

**What it is.** `flushMessageBatch` can run **concurrently** with itself, because two independent triggers call it:

- the self-rescheduling timer loop — `flushMessageBatchLoop()` (`service.js:68`), and
- the size threshold inside the hot path — `if (batch.length >= maxBatchSize) await flushMessageBatch()` (`service.js:522`).

The function reads the shared `messageBatch`, `await`s `insertMany`, then does a map-wide `messageBatch.clear()` (`service.js:62`). Because messages all carry a pre-assigned `_id`, two overlapping flushes try to insert the same documents (→ duplicate-key `BulkWriteError`), and the trailing `clear()` wipes any messages that arrived **during** the `await` window — silently dropping them.

**Real-world scenario.** A last-minute winning goal in a Champions League knockout. The room erupts: hundreds of messages per second. Room A crosses `maxBatchSize` and triggers a size-flush; mid-`insertMany`, the 1-second timer also fires a flush. They overlap. MongoDB logs duplicate-key errors, and the goal-celebration messages that arrived in those few hundred milliseconds are erased by `clear()` before they're ever persisted. Users who reload right after see a chat history with a hole exactly where the most exciting moment was.

**Impact.** Message loss scales **with load** — i.e. it's worst at peak emotional moments, which is the worst possible time for a sports chat. Also produces noisy error logs that mask real failures.

**Solution.** Replace "read → await → clear" with an **atomic swap** so in-flight arrivals are never in the same map being cleared, and add a re-entrancy guard:

```js
let messageBatch = new Map();   // was `const`
let flushInProgress = false;

async function flushMessageBatch() {
  if (flushInProgress || messageBatch.size === 0) return;
  flushInProgress = true;
  const draining = messageBatch;     // take the current batch
  messageBatch = new Map();          // new arrivals accumulate safely here
  try {
    const allMessages = [];
    const roomUpdates = [];
    draining.forEach((messages, roomId) => {
      if (messages.length) { allMessages.push(...messages); roomUpdates.push({ roomId, count: messages.length }); }
    });
    if (allMessages.length) await MessageModel.insertMany(allMessages, { ordered: false });
    // ... Redis counter pipeline unchanged ...
  } catch (e) {
    console.error("Batch flush error:", e);
  } finally {
    flushInProgress = false;          // no map-wide clear — the swap already handled it
  }
}
```

> **Which part is load-bearing:** the **atomic swap** (`messageBatch = new Map()` before any `await`) is the actual fix — it alone guarantees that messages arriving during the `await` land in a fresh map that this flush never touches, so nothing is lost and nothing is double-inserted, *even if two flushes run concurrently* (each takes a disjoint snapshot). The `flushInProgress` guard is an **optional optimization** that avoids a redundant tiny insert; its only side effect is that a room which just hit `maxBatchSize` waits up to one `batchFlush` window (1–5 s) for the next timer flush instead of flushing instantly — an acceptable trade. Do not ship the guard *without* the swap; the swap is the part that fixes the bug.

**Verify.** Unit test: seed `messageBatch` with two rooms, call `flushMessageBatch()` twice without awaiting the first, and push new messages between the calls; assert every message is inserted exactly once and none are dropped. (See Issue #8.)

**Before → After.**

| | Before | After |
|---|---|---|
| Messages lost per overlapping flush | up to `maxBatchSize` (50–150) per affected room | 0 |
| Duplicate-key errors under burst | Frequent at peak | None |
| Worst-case timing | Exactly at goal/peak moments | Eliminated |

---

### Issue #4 — Drain lock deleted by the wrong owner → double-counted message stats

**What it is.** `drainRoomCountersLoop` acquires an `NX` lock with a TTL, runs the drain, then releases with an **unconditional** delete in `finally`:

```js
// service.js:151-161
const won = await redis.set(DRAIN_LOCK_KEY, "1", { NX: true, PX: lockTtl });
if (won) {
  try { await drainRoomCounters(); }
  finally { await redis.del(DRAIN_LOCK_KEY).catch(() => {}); }
}
```

If `drainRoomCounters()` (a Mongo `bulkWrite`) outlives `lockTtl`, the lock auto-expires, **worker B** acquires a fresh lock and begins draining, and then **worker A's** `finally` deletes **B's** lock — letting a third worker enter. Two drainers reading the same swap-key both apply `$inc: { messageCount }`, double-counting.

**Real-world scenario.** During a heavy match, MongoDB is briefly slow (a competing query, disk pressure on the shared box). A drain takes 12s while the lock TTL is 10s. Worker A is still inside `bulkWrite` when the lock expires; worker B grabs it and drains the same snapshot; A finishes and deletes B's lock. The admin dashboard's per-room "messages" stat for that window is inflated ~2×. Not user-visible in chat, but it corrupts the analytics moderators use to judge room activity.

**Impact.** Stat-only corruption (no message loss), but it's a real correctness bug that worsens precisely under the DB-slowness conditions a single co-located box invites (see Infra section).

**Solution.** Be precise about root cause: the double-count happens because **the lock expires while a drain is still running**, letting a second worker legitimately acquire it and re-apply the same `$inc`. A fencing token does *not* fix that — by the time the second worker runs, the lock is genuinely free. Two independent changes are needed:

1. **Primary — stop the lock from expiring mid-drain.** Drains are normally sub-second; size the TTL far above the worst case so a slow `bulkWrite` never releases the lock early:
   ```js
   const lockTtl = Math.max(interval * 4, 60_000); // was max(interval*2, 10_000)
   ```
   For belt-and-braces on pathologically long drains, renew (extend) the lock partway through rather than relying on a single fixed TTL.

2. **Secondary — release only if still the owner**, so a worker whose lock *did* expire can't delete the lock a *different* worker now holds (the "delete someone else's lock" bug). Use a fencing token + check-and-delete via Lua:
   ```js
   // module scope: let drainToken = 0;
   const token = `${process.pid}-${++drainToken}`; // unique per acquisition (no clock/RNG needed)
   const won = await redis.set(DRAIN_LOCK_KEY, token, { NX: true, PX: lockTtl });
   if (won) {
     try { await drainRoomCounters(); }
     finally {
       await redis.eval(
         "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
         { keys: [DRAIN_LOCK_KEY], arguments: [token] }
       ).catch(() => {});
     }
   }
   ```

> Note: `drainRoomCounters` is already *crash*-safe (the `leftoverExists` check + swap-key resume), but it is **not** *concurrency*-safe — two simultaneous drainers both read the same swap key and both `$inc`. Fix #1 is what prevents the concurrency; fix #2 just stops the collateral lock-deletion.

**Verify.** Temporarily set `lockTtl` to ~500 ms and inject a 2 s delay into `drainRoomCounters`; before the fix, `messageCount` for an active room inflates faster than messages sent; after, it tracks exactly.

**Before → After.**

| | Before | After |
|---|---|---|
| `messageCount` accuracy under slow Mongo | can double-count | exact |
| Concurrent drainers possible | Yes (lock theft) | No (fenced) |

---

### Issue #5 — `connectDB` swallows failure; worker boots into a broken state

**What it is.** The Mongo connect helper catches the error and **does not rethrow or exit** (the `process.exit(1)` is commented out):

```js
// config/connection.js:15-18
} catch (error) {
  console.error("❌ MongoDB connection error:", error);
  // process.exit(1);
}
```

So `await connectDB()` in `server.js` resolves even when Mongo is unreachable, and the worker proceeds to `server.listen()` and accepts traffic. Every persistence call then fails silently in the background.

**Real-world scenario.** A deploy restarts the cluster while MongoDB is mid-restart on the same box. All 5 workers come up "successfully," accept WebSocket connections, broadcast live messages (which work — they're Redis/socket only) — but **nothing is being saved**. History loads return empty, reactions don't persist, and counters never drain. Because broadcasts still work, monitoring looks green and the data-loss goes unnoticed until someone reloads and finds an empty history.

**Impact.** Silent, total persistence failure that masquerades as a healthy service. Hard to detect without DB-level alerting.

**Solution.** Fail fast — let the existing `server.js` try/catch handle it (it already calls `process.exit(1)` on a thrown error, and PM2 will restart with backoff):

```js
} catch (error) {
  console.error("❌ MongoDB connection error:", error);
  throw error; // let server.js bootstrap fail loudly; PM2 restarts
}
```
Optionally add a `mongoose.connection.on("disconnected", ...)` readiness gate so a mid-session DB drop sheds load (503) instead of silently dropping writes.

**Verify.** Point `MONGO_URI` at a dead host and start the service → the worker must exit non-zero (and PM2 must show it restarting), not log "Server is running".

**Before → After.**

| | Before | After |
|---|---|---|
| Worker behaviour when Mongo is down | Boots "healthy", drops all writes | Refuses to start; PM2 retries |
| Detectability | Invisible until user reload | Immediate in logs / process state |

---

### Issue #6 — Per-IP rate limit throttles legitimate users behind shared NAT

**What it is.** Both message rate limiting and registration limiting key purely on IP:

```js
// socketHandler.js:347
const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`; pipeline.incr(key);
// user/controller.js:43
const existing = await redis.get(`${REG_RATE_LIMIT_PREFIX}${ip}`);
```

Defaults are aggressive: **1 message / 5 s** and **1 new account / 10 min** per IP.

**Real-world scenario.** Thousands of fans watch a match on mobile data. A carrier-grade NAT (CGNAT) puts many of them behind a handful of shared public IPs. Two strangers on the same carrier now share one rate-limit bucket: when one sends a message, the other is told "Limit reached. Retry in 5 seconds." Worse, only **one** of them can ever register an account per 10 minutes. On a university or stadium Wi-Fi, an entire venue collapses into a single bucket. Legitimate fans are blocked from chatting at exactly the moment they want to.

**Impact.** False-positive throttling that grows with audience density — directly degrades UX for the mobile-heavy sports audience the product targets.

**Solution.** Keep IP as the anti-abuse backstop but make it tolerant, and add a per-identity dimension:

- Raise defaults to something humane (e.g. **5 messages / 10 s** burst) — already admin-tunable via `rate_limit_config.js`, so this is partly a config change.
- For messages, prefer a **per-socket / per-username token bucket** (a genuine human on a shared IP isn't the abuse vector; a single socket firing 50 msg/s is). Combine: `ratelimit:{ip}` *and* `ratelimit:{socketId}`, blocking only if the **socket** bucket trips, while keeping a looser per-IP ceiling for true floods.
- For registration, combine IP with a lightweight client fingerprint or a small per-IP *quota* (e.g. 5 accounts / 10 min) rather than a hard 1.

**Verify.** From two browsers sharing one public IP, both send messages within the window → both must succeed. Then fire 50 msg/s from a single socket → that socket must be throttled while the other users are unaffected.

**Before → After.**

| | Before | After |
|---|---|---|
| Two users, same CGNAT IP | Block each other | Both chat normally |
| Stadium / campus Wi-Fi | ~1 chatter total | Per-person limits |
| Single abusive socket | Blocked | Still blocked (per-socket bucket) |

---

## 4. Low-severity / hygiene issues

### Issue #7 — In-memory reaction maps leak (not purged on room delete)

**What it is.** `reactionBatch`, `adminReactionSnapshot`, `adminReactionBatch`, `reactionRetries` are per-process maps keyed by `messageId` (`service.js:172-185`). `adminReactionSnapshot` is only evicted when its count hits zero. Crucially, **`deleteRoom` clears Redis caches but not these JS maps** (`roomManager.js:89` wipes Redis keys; the in-memory maps are never touched). Across many matches, entries for long-gone rooms accumulate.

**Real-world scenario.** A server stays up across a full weekend of fixtures — dozens of matches, each with thousands of reacted messages. The per-process maps grow match over match. Eventually a worker crosses `max_memory_restart: 1500M` and PM2 restarts it mid-match, briefly dropping the connections on that worker (users see a reconnect blip). The "garbage collector" here is effectively a process restart.

**Impact.** Slow memory creep masked by PM2 restarts; occasional user-visible reconnect blips during long uptimes.

**Solution.** Purge on room deletion and/or sweep by age:

- In `deleteRoom`, drop reaction state for that room. Cheapest: maintain a `roomId → Set<messageId>` index, or piggyback on the cache wipe. Simplest robust option: a periodic sweep (every few minutes) that deletes `adminReactionSnapshot`/`reactionBatch` entries for `messageId`s whose room is no longer in `__rooms__`.
- Add a hard TTL/`maxEntries` ceiling on these maps as a backstop.

**Verify.** Create a room, react to several messages, delete the room, and assert `adminReactionSnapshot`/`reactionBatch` hold no entries for that room's message IDs. Over a long soak (many create/delete cycles) heap should plateau rather than climb.

**Before → After.**

| | Before | After |
|---|---|---|
| Heap over a multi-match weekend | Climbs until PM2 restart | Levels off |
| Unplanned reconnect blips | Periodic | Rare |

---

### Issue #8 — No automated tests for concurrency-critical paths

**What it is.** No test suite exists. The riskiest logic in this service is concurrency-sensitive: the batch flush race (#3), the drain lock (#4), count reconciliation (`validateCounts`), and reaction merging across instances.

**Real-world scenario.** A future change to the perf-mode timings or the drain interval silently reintroduces a flush race. Without tests, it ships, and is only discovered when users report missing messages after a big match — i.e. in production, under load, with no repro.

**Impact.** Regressions in exactly the code that is hardest to reason about and most damaging when wrong.

**Solution.** Add `jest` with focused tests:
- `flushMessageBatch` under interleaved size+timer triggers (assert: no loss, no dup).
- `drainRoomCounters` idempotency + lock fencing (assert: no double `$inc`).
- `validateMessage` table-driven cases (mirrors the FE validators).
- `joinRoom`/`leaveRoom` count math, including the double-decrement race guard.

**Before → After.** Regression safety net for the concurrency code goes from none to covered; refactors become safe.

---

### Issue #9 — Hardcoded `ADMIN_KEY` in source

**What it is.** `const ADMIN_KEY = "admin_arshad_habib";` (`utils/const_config.js:1`) is committed to a repo that is pushed to GitHub.

**Real-world scenario.** The repo (or a fork/leak) exposes the key; anyone can call admin-key-gated endpoints (`isAdminKeyCorrect`) such as room wipes.

**Impact.** Credential exposure for admin-key-protected operations.

**Solution.** Move to env: `const ADMIN_KEY = process.env.ADMIN_KEY;`, fail startup if unset, and rotate the existing value. Confirm it isn't duplicated in the other repos.

**Verify.** `grep -r "admin_arshad_habib"` across all repos returns nothing; the service refuses to start when `ADMIN_KEY` is unset.

**Before → After.** Secret leaves source control; rotatable without a code change.

---

## 5. Infrastructure note — single co-located box (not a code bug, but the #1 availability risk)

**What it is.** `ecosystem.config.js:8` documents the deployment: 5 Node workers (7.5 GB) **plus Redis, MongoDB, and the OS** on a single ~12 GB box (~10.5 GB committed).

**Real-world scenario.** A viral match drives a connection surge. Node memory spikes; with only ~1.5 GB headroom, the Linux **OOM killer** may target Redis or MongoDB rather than a worker. If Redis dies, all live room membership/counts vanish cluster-wide; if Mongo dies, persistence stops. Either way, one box failing takes down chat for **all 12 sites** simultaneously.

**Impact.** Hard scaling ceiling and a single point of failure for the entire chat product.

**Solution (sequenced).**
1. **Move Redis and MongoDB off the app box** (managed or separate hosts), freeing the 12 GB for Node and removing the OOM-cross-contamination risk.
2. Add a **Redis replica** + persistence (AOF) so live state survives a Redis restart.
3. Once state is external, **add app boxes horizontally** — the Socket.io Redis adapter already coordinates them, so this is now a capacity dial, not a rewrite.
4. Front with an LB doing even WebSocket distribution; keep the per-worker 15k cap as a backstop.

**Before → After.**

| | Before | After |
|---|---|---|
| Failure blast radius | All 12 sites, one box | Isolated; app boxes are replaceable |
| Memory headroom | ~1.5 GB (OOM risk) | Full box for Node |
| Scale-out method | Vertical only (bigger box) | Horizontal (add boxes) |
| Redis state durability | Lost on crash | Survives (replica + AOF) |

---

## 6. Consolidated performance & reliability analysis (before → after)

> Behavioural facts are stated plainly; throughput/latency/memory figures are **`(projected)`** and pending a load test.

| Metric | Before | After all fixes |
|---|---|---|
| **Ban bypass rate** (determined user) | ~100% bypassable | ~0% |
| **Display-name / reaction impersonation** | Possible (payload identity echoed) | Blocked (bound identity) |
| **Message loss at peak** (goal/KO bursts) | up to 50–150 msgs/room per overlapping flush | 0 |
| **Max message size (default)** | ~1 MB transport / unbounded app | 16 KB transport / 200 chars app |
| **Profanity censoring (default)** | Off | Always on |
| **Stat accuracy** (`messageCount`) | Can double under slow DB | Exact |
| **Behaviour when DB down** | Boots healthy, drops writes silently | Fails fast, PM2 retries |
| **Shared-NAT users able to chat** | ~1 per IP bucket | Per-person |
| **Heap over long uptime** | Climbs → PM2 restart | Levels off |
| **Failure blast radius** | All 12 sites (one box) | Isolated app tier |
| **Hot-path per-message cost** | 1 Redis RTT (ban+room+rate) | 1 Redis RTT + ~5–20 µs validation `(projected)` |
| **Sustained throughput** | High (batched) | Same order; no regression `(projected)` |

**Net:** the fixes add a negligible per-message CPU cost (microseconds of trim/length/censor) while removing message loss, ban evasion, silent write failure, and stat corruption. There is **no throughput regression** — the hot path remains a single Redis pipeline round-trip; batching, caching, and the counter-drain design are untouched.

---

## 7. Overall stability & user-experience outcome

**Stability.** After Issues #3–#5 and #7, the most damaging failure modes — peak-time message loss, silent persistence failure, stat corruption, and slow memory creep — are eliminated. After the infra split (Section 5), a single host failure no longer takes down all 12 sites, and Redis state survives a restart. The service moves from "works well until it's stressed" to "degrades gracefully under stress."

**User experience.**
- **Chat history is trustworthy** — the goal-moment messages are still there on reload (Issue #3).
- **Moderation actually works** — a banned troll stays banned through the whole match, and nobody can post or react under a stolen name (Issue #1); genuine fans on shared mobile/Wi-Fi aren't falsely silenced (Issue #6).
- **Rooms stay readable** — no megabyte text-walls or unfiltered scam-link floods by default (Issue #2).
- **Fewer disruptive reconnects** during long broadcast days (Issue #7).
- **Counts and dashboards are accurate**, so moderators make decisions on real data (Issue #4).

**What was already excellent (keep it).** The PM2 + Redis-adapter scale-out model, the batched write path, the elected-leader counter drain with crash-safe swap-keys, the read-path Redis cache with in-flight coalescing, cross-process broadcast throttling, and dynamic Redis-pub/sub config (perf mode / feature flags / rate limits) are all genuinely strong and should be preserved as-is.

---

## 8. Suggested rollout order

1. **Issue #1** (identity binding — ban **and** impersonation, all handlers) and **#2** (size cap + always-on essential validation) — small server diffs, immediate security/abuse win. ⚠️ **Issue #1 has a client dependency**: ship the frontend re-`join_room`-on-reconnect change *with or before* the server change, or reconnecting users get silently dropped. *(hours)*
2. **Issue #3** (flush swap) and **#5** (fail-fast DB) — eliminate silent data loss. *(hours)*
3. **Issue #4** (lock fencing) and **#6** (rate-limit defaults/keying) — correctness + UX. *(half day)*
4. **Issue #9** (env-ify `ADMIN_KEY`) — quick, do with a rotation. *(minutes)*
5. **Issue #7** (map purge) and **#8** (tests) — hardening. *(1–2 days)*
6. **Section 5 infra split** — schedule as an ops project; biggest availability gain. *(separate workstream)*

---

*End of audit. Code references are against the repository state on 2026-06-28; line numbers may drift as fixes land.*
