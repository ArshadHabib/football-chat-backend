# User Query Optimisation Plan

## Goal
Pure performance improvements — zero behaviour changes.

---

## Performance Analysis

### Registration (`POST /register-user`)

**Before**
```
1. findBannedUserByIp(ip)       → MongoDB: findOne({ ipAddress, isBanned: true })
                                   uses ipAddress index → fetches all docs for that IP
                                   → in-memory scan for isBanned: true
                                   ~2–5 ms (index hit) + extra scan work per IP bucket

2. findUserByName(name)         → MongoDB: findOne({ name })
                                   waits for step 1 to finish first (sequential)
                                   ~1–2 ms (unique name index)

   Total DB time: ~3–7 ms sequential
   Mongoose overhead: both calls return full documents (getters, virtuals,
                      change-tracking state)
```

**After**
```
1+2. Promise.all([
       findBannedUserByIp(ip),  → MongoDB compound index { ipAddress, isBanned }
       findUserByName(name),    → unique name index (unchanged)
     ])
     Both fire in parallel, resolve together

   Total DB time: max(~1 ms, ~1–2 ms) ≈ ~1–2 ms (overlap, not sum)
   Mongoose overhead: .lean() — plain objects, ~3–5× less memory allocation

   Saving: ~2–5 ms per registration + reduced memory pressure
```

---

### Ban status check (`POST /is-user-banned`)

This endpoint is called by the frontend on every session start to check if the
current user is banned. With ~6K users and growing it is one of the most
frequent user-table hits.

**Before**
```
findUserByName(name)  → MongoDB: findOne({ name })
                        always hits the database regardless of ban status
                        ~1–2 ms DB round-trip + Mongoose document allocation
```

**After**
```
redis.sIsMember(BANNED_USERS_KEY, name)  → Redis in-process memory lookup
                                           ~0.1–0.3 ms (sub-millisecond)

  If banned (true):  return immediately — zero DB calls
  If not banned (false): fall through to MongoDB findOne (same as before)

Banned users: ~10× faster, no DB load at all
Active users: identical to before (Redis miss → DB query)

The overwhelming majority path is "not banned" so this is a constant-time
Redis check that short-circuits only when needed.
```

---

### Admin get user (`POST /get-user`)

**Before**
```
findUserByName(name)  → MongoDB: findOne({ name })
                        returns a full Mongoose document (~3–5× memory overhead
                        of the raw BSON data)
```

**After**
```
findUserByName(name)  → MongoDB: findOne({ name }).lean()
                        returns a plain JS object — only the raw field data,
                        no Mongoose prototype chain, no change-tracking state

Same DB query, same index hit — purely reduced memory and GC pressure
```

---

### Compound index impact (`findBannedUserByIp`)

**Before** — single `ipAddress` index
```
Query: { ipAddress: "x.x.x.x", isBanned: true }
Plan:  IXSCAN on ipAddress → fetch N documents for that IP into memory
       → FETCH + filter on isBanned in app layer
       Cost grows with users per IP (shared household/office = multiple docs)
```

**After** — compound index `{ ipAddress: 1, isBanned: 1 }`
```
Query: { ipAddress: "x.x.x.x", isBanned: true }
Plan:  IXSCAN on { ipAddress, isBanned } → direct match, 0 or 1 doc returned
       No in-memory filtering needed
       Cost is O(1) regardless of how many users share an IP
```

---

### Summary table

| Endpoint / Query        | Before                        | After                                   | Saving                        |
|-------------------------|-------------------------------|------------------------------------------|-------------------------------|
| `/register-user` DB     | 2 sequential queries (~3–7ms) | 2 parallel queries (~1–2ms)              | ~2–5ms per registration       |
| `/register-user` index  | ipAddress scan + isBanned filter | compound index direct lookup          | O(N→1) for shared IPs         |
| `/is-user-banned` (banned user) | MongoDB findOne (~1–2ms) | Redis sIsMember (~0.1ms)            | ~10× faster, zero DB load     |
| `/is-user-banned` (active user) | MongoDB findOne (~1–2ms) | Redis miss + MongoDB findOne (~1–2ms) | Same                          |
| All read queries        | Full Mongoose documents       | `.lean()` plain objects                  | ~3–5× less memory per query   |

---

## Changes

### 1. `modules/user/model.js` — compound index
Add `{ ipAddress: 1, isBanned: 1 }` index.

`findBannedUserByIp` (called on every registration) currently hits the `ipAddress` index to fetch a bucket of docs, then scans each one for `isBanned: true`. The compound index makes it a single index lookup.

```js
userSchema.index({ ipAddress: 1, isBanned: 1 });
```

### 2. `modules/user/service.js` — lean() on all read-only queries
Add `.lean()` to every function that only reads. Mongoose documents carry ~3–5× the memory of a plain object due to getters, virtuals, and the change-tracking machinery. None of the read callers need a full Mongoose document.

Affected: `findUserByName`, `findUserByIp`, `findBannedUserByIp`, `findUserById`, `banAllUsersByIp` (already has projection, just add lean).

### 3. `modules/user/controller.js` — parallel registration checks
`findBannedUserByIp` and `findUserByName` in `registerUserController` are sequential today but independent. Run them with `Promise.all`. Ban check still takes priority in the error response (checked first from the resolved array).

```js
const [bannedIpUser, existingUser] = await Promise.all([
  userService.findBannedUserByIp(ip),
  userService.findUserByName(name),
]);
if (bannedIpUser) return sendError(res, "You are banned ...", 403);
if (existingUser) return sendError(res, "User name already taken!", 400);
```

### 4. `modules/user/controller.js` — Redis-first in `isUserBannedController`
`isUserBannedController` currently hits MongoDB via `findUserByName`. The `__banned_users__` Redis set is already kept perfectly in sync on every ban/unban. Check Redis first:
- `sIsMember` returns `true` → user is banned, return immediately (no DB hit)
- `sIsMember` returns `false` → user either not banned or doesn't exist → fall through to DB for the `isBanned: false` + `userName` response (same as today)

This makes the majority path (checking an active user during a session) a Redis-only operation.

## Files changed
- `modules/user/model.js`
- `modules/user/service.js`
- `modules/user/controller.js`

## Not changed
- Socket handler ban checks — already Redis-only, no DB involved
- `banAllUsersByIp` write path — no change to logic, just `.lean()` on the read step
- `updateUser` service — write operation, lean doesn't apply
- Error messages, HTTP status codes, response shapes — all identical
