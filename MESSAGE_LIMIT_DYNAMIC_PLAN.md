# Phase 2 — Dynamic Message Rate-Limit (Admin-Controlled) — Implementation Plan

## Goal

Today the message rate limit (`MESSAGES_LIMIT` / `LIMIT_SECONDS` on the client, `rateLimitMax` / `rateLimitWindowSeconds` on the server) is **hard-coded** at `1 message / 5 seconds` and always on. Phase 2 makes it **admin-controlled and dynamic**, exactly the way `FEATURE_VALIDATION` was made dynamic in Phase 1:

- Admin can **enable/disable** the limit (`enabled` boolean). When **off**, no rate limit is applied **on either the backend or the client**.
- Admin can **edit the two numbers** — message count (default **1**) and window seconds (default **5**) — via an edit icon → modal in the admin dashboard.
- Defaults are `enabled: true, max: 1, windowSeconds: 5` on both client and backend (preserves current behavior).
- The setting is **cluster-wide and global** (not per-room), persisted in Redis, propagated to every PM2 instance via pub/sub.
- On **join**, the client is told the current config (mirrors how `validation` is sent on `join_result`).
- When the admin changes anything **mid-session**, all connected clients are updated in **real time** (mirrors `validation_changed`).

This reuses the proven Phase-1 architecture end-to-end. The only genuinely new shape is that we carry **a small object** (`{ enabled, max, windowSeconds }`) instead of a single boolean.

---

## 0. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Default on/off | **Enabled** (`1 / 5s`) | Preserves today's always-on spam protection. A fresh boot or an old server falls back to enabled. |
| Storage | **Dedicated `utils/rate_limit_config.js`** module | Numbers + toggle travel as one cohesive object. Zero risk to the boolean-only `feature_flags.js` / `validation` / `registration` path. Mirrors the feature-flags lifecycle 1:1. |
| Input bounds | `max` ∈ **[1, 100]** integer, `windowSeconds` ∈ **[1, 3600]** integer | Rejects typos (e.g. `99999`) that could lock out chat or effectively disable the limit. Enforced authoritatively on the backend, mirrored on the client for UX. |
| Source of truth | The new config **replaces** `perfomance_config.js`'s `rateLimitMax` / `rateLimitWindowSeconds`, which are **removed** | Those two per-mode fields were the only inputs to the rate-limit pipeline (confirmed: their sole consumer is `socketHandler.js`). Once the pipeline reads `rate_limit_config`, they're dead config — removed from all three modes to avoid a misleading second source of truth. |

---

## 1. Canonical Config Shape

One object, everywhere:

```js
{ enabled: boolean, max: number, windowSeconds: number }
```

- **Redis key:** `__rate_limit_config__` — a single JSON string (atomic read/write, one key). Deliberately namespaced under the `__...__` control-plane convention (cf. `__perf_mode_current__`), **not** under the `ratelimit:` prefix that holds the per-IP counters (`ratelimit:{ip}`), so the two can never overlap.
- **Pub/sub channel:** `__rate_limit_change__` (new, dedicated — mirrors `__feature_change__`).
- **Socket event (server → client):** `rate_limit_changed`, payload `{ enabled, max, windowSeconds }`.
- **`join_result` extension:** adds `rateLimit: { enabled, max, windowSeconds }`.
- **Admin endpoint:** `set-rate-limit-config` accepts a **partial** `{ enabled?, max?, windowSeconds? }`, merges with current, validates, persists, broadcasts. `get-rate-limit-config` returns the full object.

Defaults: `{ enabled: true, max: 1, windowSeconds: 5 }`.

---

## 2. Backend — `football-chat-backend`

### 2.1 New module — `utils/rate_limit_config.js`

A near-exact structural copy of [utils/feature_flags.js](utils/feature_flags.js), but for one JSON object instead of boolean flags.

```js
// Cluster-wide message rate-limit config with Redis persistence + pub/sub.
// Same source-of-truth pattern as utils/feature_flags.js:
//   - Redis is the source of truth (key: __rate_limit_config__, JSON string).
//   - Each instance keeps a hot in-memory copy (read per message — must be fast).
//   - setConfig() persists + publishes; every instance (incl. originator) applies
//     via the __rate_limit_change__ subscription.
//   - onConfigChange() lets the socket layer broadcast to its sockets, without
//     this module importing socket.io.

const { pubClient, rateLimitSubClient } = require("@project/config/redis");

const KEY = "__rate_limit_config__";
const CHANNEL = "__rate_limit_change__";

const DEFAULTS = Object.freeze({ enabled: true, max: 1, windowSeconds: 5 });

// Guardrails — authoritative. Mirrored (looser) on the client for UX only.
const MAX_BOUND = 100;        // messages
const WINDOW_BOUND = 3600;    // seconds

let config = { ...DEFAULTS };

const listeners = new Set();
function onConfigChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}
function notifyListeners(cfg) {
  listeners.forEach((fn) => {
    try { fn(cfg); } catch (err) { console.error("Rate-limit listener error:", err); }
  });
}

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// Coerce an arbitrary (possibly partial) input into a fully valid config,
// merging onto a base (current config by default).
function normalize(partial, base = config) {
  return {
    enabled: typeof partial.enabled === "boolean" ? partial.enabled : base.enabled,
    max: partial.max === undefined ? base.max : clampInt(partial.max, base.max, 1, MAX_BOUND),
    windowSeconds:
      partial.windowSeconds === undefined
        ? base.windowSeconds
        : clampInt(partial.windowSeconds, base.windowSeconds, 1, WINDOW_BOUND),
  };
}

function applyConfig(next) { config = normalize(next, DEFAULTS); }
function getConfig() { return { ...config }; }

async function loadFromRedis() {
  const raw = await pubClient.get(KEY);
  if (raw == null) {
    config = { ...DEFAULTS };
    await pubClient.set(KEY, JSON.stringify(config)); // seed
  } else {
    try { applyConfig(JSON.parse(raw)); }
    catch { config = { ...DEFAULTS }; await pubClient.set(KEY, JSON.stringify(config)); }
  }
  console.log("✅ Rate-limit config loaded:", config);
}

// Admin path. Accepts a partial, merges onto current, validates, persists,
// notifies local listeners synchronously, then publishes for other instances.
async function setConfig(partial) {
  const next = normalize(partial || {}, config);
  config = next;
  notifyListeners(getConfig());
  await pubClient.set(KEY, JSON.stringify(next));
  await pubClient.publish(CHANNEL, JSON.stringify(next));
  return getConfig();
}

async function subscribeToChanges() {
  await rateLimitSubClient.subscribe(CHANNEL, (message) => {
    try {
      applyConfig(JSON.parse(message));
      notifyListeners(getConfig());
    } catch (err) {
      console.error("Rate-limit pub/sub message error:", err, message);
    }
  });
}

module.exports = { loadFromRedis, subscribeToChanges, getConfig, setConfig, onConfigChange, DEFAULTS };
```

**Why a dedicated module, not `feature_flags.js`:** `feature_flags.js` is boolean-only (`applyFlag` does `!!value`; the controller rejects non-booleans). Bundling `{ enabled, max, windowSeconds }` there would force typed branching through the proven `validation`/`registration` path. A parallel module keeps the blast radius at zero and reads identically.

### 2.2 `config/redis.js` — add a dedicated sub client

Follows the existing one-client-per-channel convention.

```js
const rateLimitSubClient = pubClient.duplicate(); // used exclusively for __rate_limit_change__
// ...
rateLimitSubClient.on("error", (err) => console.error("Redis rate-limit-sub error:", err));
// inside connectRedis(): add rateLimitSubClient.connect() to the Promise.all([...])
// export it
module.exports = { pubClient, subClient, perfSubClient, featuresSubClient, rateLimitSubClient, connectRedis };
```

### 2.3 `server.js` — boot + re-hydrate

Mirror the feature-flags lifecycle, placed right after it ([server.js:101-102](server.js#L101-L102)):

```js
const rateLimitConfig = require("@project/utils/rate_limit_config");
// ... after featureFlags.loadFromRedis()/subscribeToChanges():
await rateLimitConfig.loadFromRedis();
await rateLimitConfig.subscribeToChanges();
```

And in the `pubClient.on("ready", ...)` re-hydrate block ([server.js:115-136](server.js#L115-L136)):

```js
rateLimitConfig
  .loadFromRedis()
  .catch((err) => console.error("Rate-limit config re-hydrate failed:", err));
```

### 2.4 `socket/socketHandler.js` — enforce + broadcast + join_result

**Imports** (alongside the existing `feature_flags` import at [socketHandler.js:36-40](socket/socketHandler.js#L36-L40)):

```js
const {
  getConfig: getRateLimitConfig,
  onConfigChange: onRateLimitChange,
} = require("@project/utils/rate_limit_config");
```

**Remove the now-dead `getCurrentPerformanceMode` import** from `socketHandler.js` ([socketHandler.js:24-26](socket/socketHandler.js#L24-L26)). The `room_message` rate-limit block was its only consumer in this file — once that reads `rate_limit_config`, the import is unused. (`getCurrentPerformanceMode` itself stays exported from `perfomance_config.js`; `roomManager.js`, `service.js`, `adminEventService.js`, and `controller.js` still use it for batch/cache/debounce settings.)

**Broadcast listener** — register inside `setupSocketHandlers(io)`, next to the existing `onFlagChange` block ([socketHandler.js:71-74](socket/socketHandler.js#L71-L74)). Same `io.local.emit` reasoning (each instance gets the pub/sub message independently; cluster-wide `io.emit` would N×N duplicate):

```js
onRateLimitChange((cfg) => {
  io.local.emit("rate_limit_changed", cfg); // { enabled, max, windowSeconds }
});
```

**`join_room` success path** — attach the config alongside `result.validation` ([socketHandler.js:301-305](socket/socketHandler.js#L301-L305)):

```js
result.validation = !!getFlag(FEATURE_VALIDATION);
result.rateLimit = getRateLimitConfig(); // { enabled, max, windowSeconds }
socket.emit("join_result", result);
```

**`room_message` handler** — replace the perf-mode read and gate the entire pipeline on `enabled`. Current code ([socketHandler.js:321-365](socket/socketHandler.js#L321-L365)):

```js
const { rateLimitMax, rateLimitWindowSeconds } =
  getCurrentPerformanceMode().settings;
const pipeline = redis.multi();
pipeline.sIsMember(BANNED_USERS_KEY, senderName); // [0]
pipeline.sIsMember(REDIS_ROOMS_SET, roomId);      // [1]
if (ip) {
  const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;
  pipeline.incr(key);                              // [2]
  pipeline.expire(key, rateLimitWindowSeconds, "NX"); // [3]
  pipeline.ttl(key);                               // [4]
}
```

becomes:

```js
const rl = getRateLimitConfig();                    // { enabled, max, windowSeconds }
const rateLimitActive = rl.enabled && !!ip;         // only enforce when on AND we have an IP
const pipeline = redis.multi();
pipeline.sIsMember(BANNED_USERS_KEY, senderName);   // [0]
pipeline.sIsMember(REDIS_ROOMS_SET, roomId);        // [1]
if (rateLimitActive) {
  const key = `${REDIS_RATE_LIMIT_PREFIX}${ip}`;
  pipeline.incr(key);                               // [2]
  pipeline.expire(key, rl.windowSeconds, "NX");     // [3]
  pipeline.ttl(key);                                // [4]
}
const results = await pipeline.exec();
const isBanned = results[0];
if (isBanned) return;
const roomStillExists = results[1];
if (!roomStillExists) return;
if (rateLimitActive) {
  const count = results[2];
  const retryAfter = results[4];
  if (count > rl.max) {
    socket.emit("server_rate_limit", { message: `Limit reached. Retry in ${retryAfter} seconds`, retryAfter });
    return;
  }
  if (count === rl.max) {
    // Pre-emptive at-cap signal (unchanged logic from Phase 1 follow-up).
    socket.emit("server_rate_limit", { message: `Limit reached. Retry in ${retryAfter} seconds`, retryAfter });
    // fall through — broadcast normally
  }
}
```

When `enabled` is **off**, the `incr`/`expire`/`ttl` commands are never queued — the IP counter isn't even touched, so toggling off is a clean no-op (and actually saves 3 Redis ops per message). The ban + room-existence checks are untouched.

### 2.5 `modules/chat/controller.js` — two new controllers

```js
const rateLimitConfig = require("@project/utils/rate_limit_config");

async function setRateLimitConfigController(req, res) {
  const { enabled, max, windowSeconds } = req.body;
  try {
    if (enabled !== undefined && typeof enabled !== "boolean")
      return sendError(res, "'enabled' must be a boolean", 400);
    if (max !== undefined && !Number.isFinite(Number(max)))
      return sendError(res, "'max' must be a number", 400);
    if (windowSeconds !== undefined && !Number.isFinite(Number(windowSeconds)))
      return sendError(res, "'windowSeconds' must be a number", 400);
    // setConfig clamps to [1,100] / [1,3600] and ignores absent fields.
    const result = await rateLimitConfig.setConfig({ enabled, max, windowSeconds });
    return sendResponse(res, result, "Rate-limit config updated", 200);
  } catch (error) {
    return sendError(res, error?.message || "Error setting rate-limit config", 500);
  }
}

async function getRateLimitConfigController(req, res) {
  try {
    return sendResponse(res, rateLimitConfig.getConfig(), "Success in getting rate-limit config", 200);
  } catch (error) {
    return sendError(res, error?.message || "Error getting rate-limit config", 500);
  }
}
// export both
```

### 2.6 `modules/chat/index.js` — two new routes

```js
router.post("/set-rate-limit-config", isAdminKeyCorrect, setRateLimitConfigController);
router.post("/get-rate-limit-config", isAdminKeyCorrect, getRateLimitConfigController);
```

These are reachable through the proxy automatically — the router is mounted at both `/api/next/chat` and `/api/chat/chat` ([server.js:54](server.js#L54), [server.js:73](server.js#L73)).

---

## 3. Middle Backend (Proxy) — `football-backend`

Thread two new endpoints through the same pattern as `set-feature-flag` (admin → this service → chat backend, with `adminKey` injected).

### 3.1 `utils/socket_apis_endpoints.js`

```js
setRateLimitConfig: `${CHAT_SERVER_BASE_URL}/api/next/chat/set-rate-limit-config`,
getRateLimitConfig: `${CHAT_SERVER_BASE_URL}/api/next/chat/get-rate-limit-config`,
```

### 3.2 `utils/socket_api_calls.js`

```js
const setRateLimitConfigApiCall = async (payload) => {
  try {
    const result = await axios.post(CHAT_ENDPOINTS.chat.setRateLimitConfig, { ...payload, adminKey: ADMIN_KEY });
    return result?.data?.data;
  } catch (error) { console.error("Error in Set Rate-Limit Config API Call:", error.message); return null; }
};
const getRateLimitConfigApiCall = async () => {
  try {
    const result = await axios.post(CHAT_ENDPOINTS.chat.getRateLimitConfig, { adminKey: ADMIN_KEY });
    return result?.data?.data;
  } catch (error) { console.error("Error in Get Rate-Limit Config API Call:", error.message); return null; }
};
// export both
```

### 3.3 `modules/match/controller.js` + `modules/match/index.js`

```js
// controller.js
async function setRateLimitConfigController(req, res) {
  try {
    const { enabled, max, windowSeconds } = req.body;
    const result = await setRateLimitConfigApiCall({ enabled, max, windowSeconds });
    return sendResponse(res, result, "Updated Successfully!", 200);
  } catch (error) { return sendError(res, error?.message || "Something went wrong.", 500); }
}
async function getRateLimitConfigController(req, res) {
  try { return sendResponse(res, await getRateLimitConfigApiCall(), "Got Successfully!", 200); }
  catch (error) { return sendError(res, error?.message || "Something went wrong.", 500); }
}

// index.js — same guards as the feature-flag routes (isAdmin, isUserLoggedIn)
router.post("/set-rate-limit-config", isAdmin, isUserLoggedIn, setRateLimitConfigController);
router.get("/get-rate-limit-config", isAdmin, isUserLoggedIn, getRateLimitConfigController);
```

---

## 4. Admin UI — `football-admin`

### 4.1 `src/utils/axios.ts` — two endpoints

```ts
matches: {
  // ...
  setRateLimitConfig: '/api/next/match/set-rate-limit-config',
  getRateLimitConfig: '/api/next/match/get-rate-limit-config',
}
```

### 4.2 `src/sections/matches/view/matches-list-view.tsx`

This is where the validation/registration switches and the server-mode radio live ([matches-list-view.tsx:839-897](../football-admin/src/sections/matches/view/matches-list-view.tsx#L839-L897)). Add alongside them.

> **Implemented differently — see [Implementation Notes (2026-06-07)](#implementation-notes--2026-06-07).** The edit modal below was specified with plain `TextField`s + a client-side clamp on Save. It shipped instead using React Hook Form + Yup (`editMessageLimitSchema`) with `RHFTextField`, matching the other modals in this view (Set Time, Add Category) so each field shows an **inline validation error** and Save is blocked until valid. The `rateLimitDraft` / `isSavingRateLimit` state in the snippets below was replaced by the RHF form. The authoritative code is in the notes.

**State** (next to `featureFlags`, [matches-list-view.tsx:166-169](../football-admin/src/sections/matches/view/matches-list-view.tsx#L166-L169)):

```tsx
const [rateLimit, setRateLimit] = useState<{ enabled: boolean | null; max: number; windowSeconds: number }>({
  enabled: null, max: 1, windowSeconds: 5, // null until fetched, like featureFlags
});
const [rateLimitModalOpen, setRateLimitModalOpen] = useState(false);
const [rateLimitDraft, setRateLimitDraft] = useState({ max: 1, windowSeconds: 5 });
const [isSavingRateLimit, setIsSavingRateLimit] = useState(false);
```

**Loader** (next to `getFeatureFlags`, [matches-list-view.tsx:494-505](../football-admin/src/sections/matches/view/matches-list-view.tsx#L494-L505); call it from the same mount effect at [matches-list-view.tsx:712-715](../football-admin/src/sections/matches/view/matches-list-view.tsx#L712-L715)):

```tsx
const getRateLimit = useCallback(async () => {
  try {
    const { data } = await axios.get(endpoints.matches.getRateLimitConfig);
    const d = data?.data;
    setRateLimit({ enabled: !!d?.enabled, max: d?.max ?? 1, windowSeconds: d?.windowSeconds ?? 5 });
  } catch (e) { console.error('Error fetching rate-limit config:', e); }
}, []);
```

**Toggle handler** (optimistic + rollback, mirrors `handleFeatureFlagChange` at [matches-list-view.tsx:752-776](../football-admin/src/sections/matches/view/matches-list-view.tsx#L752-L776)):

```tsx
const handleRateLimitToggle = useCallback(async (newValue: boolean) => {
  const old = rateLimit.enabled;
  setRateLimit((p) => ({ ...p, enabled: newValue }));
  try {
    await axios.post(endpoints.matches.setRateLimitConfig, { enabled: newValue });
    enqueueSnackbar(`Message Limit: ${newValue ? 'ON' : 'OFF'}`, { variant: 'success' });
  } catch (e) {
    enqueueSnackbar('Error updating message limit!', { variant: 'error' });
    setRateLimit((p) => ({ ...p, enabled: old }));
  }
}, [rateLimit.enabled, enqueueSnackbar]);
```

**Save handler** (from the modal — validates bounds client-side, then posts the two numbers):

```tsx
const handleRateLimitSave = useCallback(async () => {
  const max = Math.min(Math.max(Math.floor(Number(rateLimitDraft.max) || 1), 1), 100);
  const windowSeconds = Math.min(Math.max(Math.floor(Number(rateLimitDraft.windowSeconds) || 1), 1), 3600);
  setIsSavingRateLimit(true);
  try {
    const { data } = await axios.post(endpoints.matches.setRateLimitConfig, { max, windowSeconds });
    const d = data?.data;
    setRateLimit((p) => ({ ...p, max: d?.max ?? max, windowSeconds: d?.windowSeconds ?? windowSeconds }));
    enqueueSnackbar('Message limit updated', { variant: 'success' });
    setRateLimitModalOpen(false);
  } catch (e) {
    enqueueSnackbar('Error updating message limit!', { variant: 'error' });
  } finally { setIsSavingRateLimit(false); }
}, [rateLimitDraft, enqueueSnackbar]);
```

**UI** — a `Switch` + an edit `IconButton`, added to the same `<Stack>` as the validation switch:

```tsx
<Stack direction="row" alignItems="center" sx={{ ml: 0 }}>
  <FormControlLabel
    control={
      <Switch
        checked={!!rateLimit.enabled}
        disabled={rateLimit.enabled === null}
        onChange={(e) => handleRateLimitToggle(e.target.checked)}
      />
    }
    label={`Message Limit (${rateLimit.max}/${rateLimit.windowSeconds}s)`}
    labelPlacement="start"
    sx={{ ml: 0 }}
  />
  <IconButton
    size="small"
    disabled={rateLimit.enabled === null}
    onClick={() => { setRateLimitDraft({ max: rateLimit.max, windowSeconds: rateLimit.windowSeconds }); setRateLimitModalOpen(true); }}
  >
    <Iconify icon="solar:pen-bold" />
  </IconButton>
</Stack>
```

**Modal** — reuse the `ConfirmDialog` pattern ([football-admin/src/components/custom-dialog/confirm-dialog.tsx](../football-admin/src/components/custom-dialog/confirm-dialog.tsx)) with two number `TextField`s:

```tsx
<ConfirmDialog
  open={rateLimitModalOpen}
  onClose={() => setRateLimitModalOpen(false)}
  title="Edit Message Limit"
  content={
    <Stack spacing={2} sx={{ pt: 1 }}>
      <TextField
        type="number" label="Messages allowed" value={rateLimitDraft.max}
        onChange={(e) => setRateLimitDraft((p) => ({ ...p, max: Number(e.target.value) }))}
        inputProps={{ min: 1, max: 100 }} helperText="1–100"
      />
      <TextField
        type="number" label="Per window (seconds)" value={rateLimitDraft.windowSeconds}
        onChange={(e) => setRateLimitDraft((p) => ({ ...p, windowSeconds: Number(e.target.value) }))}
        inputProps={{ min: 1, max: 3600 }} helperText="1–3600"
      />
    </Stack>
  }
  action={<LoadingButton variant="contained" loading={isSavingRateLimit} onClick={handleRateLimitSave}>Save</LoadingButton>}
/>
```

The label `Message Limit (1/5s)` doubles as a live readout of the current numbers.

---

## 5. Chat Client — `football-next-score8o8`

### 5.1 Replace the hard-coded constants with state + ref

Today ([chatBox.tsx:69-71](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L69-L71)):

```ts
const MESSAGES_LIMIT = 1; //20;
const LIMIT_SECONDS = 5; //30;
```

Replace with component state (defaults preserve current behavior) plus a **ref mirror** so `checkRateLimit` reads fresh values without stale closures or dependency churn:

```ts
const [messageLimit, setMessageLimit] = useState({ enabled: true, max: 1, windowSeconds: 5 });
const messageLimitRef = useRef(messageLimit);
useEffect(() => { messageLimitRef.current = messageLimit; }, [messageLimit]);
```

`STORE_MESSAGES_LIMIT` (line 70) is unrelated (message history cap) and stays a constant.

### 5.2 `checkRateLimit` — dynamic + short-circuit when disabled

Current ([chatBox.tsx:1242-1263](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1242-L1263)) reads the constants. New version reads the ref and bails immediately when disabled:

```ts
const checkRateLimit = useCallback((): boolean => {
  const { enabled, max, windowSeconds } = messageLimitRef.current;
  if (!enabled) return false; // limit off → never rate-limit
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const recent = messageTimestampsRef.current.filter((ts) => ts > now - windowMs);
  messageTimestampsRef.current = recent;
  if (recent.length >= max) {
    const remainingMs = recent[0] + windowMs - now;
    setRateLimitExceeded(true);
    setRemainingSeconds(Math.max(0, Math.ceil(remainingMs / 1000)));
    return true;
  }
  return false;
}, []); // deps stay [] — reads via ref
```

No change needed in `handleSendMessage` — it already calls `checkRateLimit()` and the post-send `checkRateLimit()` re-check ([chatBox.tsx:1721](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1721), [chatBox.tsx:1779](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1779)). When the limit is off, both calls return `false` → sends are never throttled client-side.

### 5.3 `join_result` — read the config

Extend the existing handler ([chatBox.tsx:1297-1339](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1297-L1339)), next to the `data.validation` read:

```ts
async (data: { success: boolean; /* ... */ validation?: boolean;
  rateLimit?: { enabled: boolean; max: number; windowSeconds: number } }) => {
  // ...existing
  if (typeof data.validation === "boolean") setNonEssentialValidationOn(data.validation);
  if (data.rateLimit) applyRateLimit(data.rateLimit); // see 5.5
}
```

### 5.4 `rate_limit_changed` — real-time updates

New listener next to `validation_changed` ([chatBox.tsx:1345-1347](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1345-L1347)):

```ts
newSocket.on("rate_limit_changed", (data: { enabled: boolean; max: number; windowSeconds: number }) => {
  applyRateLimit(data);
});
```

### 5.5 `applyRateLimit` helper — set state + clear a stranded cooldown

When the admin **disables** the limit while a user is mid-cooldown, the user must not stay stuck behind a countdown that will never be relieved by the (now-skipped) server signal. So on disable, clear the cooldown immediately:

```ts
const applyRateLimit = useCallback((cfg: { enabled: boolean; max: number; windowSeconds: number }) => {
  setMessageLimit({ enabled: !!cfg.enabled, max: cfg.max, windowSeconds: cfg.windowSeconds });
  if (!cfg.enabled) {
    setRateLimitExceeded(false);
    setRemainingSeconds(0);
    messageTimestampsRef.current = [];
  }
}, []);
```

The decrement countdown effect ([chatBox.tsx:1224-1240](../football-next-score8o8/src/components/chatBox/chatBox.tsx#L1224-L1240)) is unchanged — it already ticks `remainingSeconds` down regardless of source.

**Backwards compatibility:** a new client against an **old server** receives no `rateLimit` on `join_result` and no `rate_limit_changed` event → keeps its `enabled: true, max: 1, windowSeconds: 5` default = today's behavior. An **old client** against a new server ignores the new field/event and keeps its hard-coded `1/5` = today's behavior.

---

## 6. Backwards Compatibility

| Scenario | Result |
|---|---|
| **New client + old server** | No `rateLimit` in `join_result`, no `rate_limit_changed`. Client keeps default `enabled:true, 1/5`. Identical to today. |
| **Old client + new server** | Ignores the new field + event. Uses hard-coded `1/5`. Identical to today. |
| **Admin toggles OFF, client open** | `rate_limit_changed{enabled:false}` → client clears any active cooldown and stops throttling. Backend skips the rate-limit pipeline entirely. |
| **Admin edits numbers, client open** | `rate_limit_changed{max,windowSeconds}` → next send uses new values. Any in-flight countdown finishes on the old window (harmless). |
| **Admin changes, client reconnects** | New socket → `join_room` → `join_result.rateLimit` carries current config → client syncs. |
| **Instance crashes/respawns** | Boots → `loadFromRedis()` hydrates from Redis (not defaults), so it can't silently desync. Re-hydrates on Redis `ready` too. |

---

## 7. Performance Analysis

### Per `room_message` — backend

| Phase | Limit ON | Limit OFF |
|---|---|---|
| `getRateLimitConfig()` | in-memory object spread, ~0.1 µs | same |
| Redis pipeline | `sIsMember×2 + incr + expire + ttl` (5 cmds, 1 RTT) — **identical to today** | `sIsMember×2` only (**3 fewer Redis commands**, still 1 RTT) |
| Branch logic | same `count` compares as today | skipped |

When ON, byte-for-byte the same cost as the current implementation (we swapped the perf-mode object read for an equivalent in-memory object read). When OFF, the per-IP counter isn't touched at all — strictly cheaper.

### Per `join_result` — backend

One extra in-memory object read + one nested object on the existing emit. Indistinguishable from baseline (same shape as the Phase-1 `validation` addition).

### Per config change — backend (rare, admin-triggered)

Identical shape to `validation_changed`: one Redis `SET` + one `PUBLISH`; each PM2 instance applies it and does one `io.local.emit` per connected socket on that instance. At 30 000 cluster-wide viewers across 5 instances → ~6 000 small (`~40 B`) broadcasts per instance, single-digit ms total, only when an admin clicks. No `io.emit` (would N×N fan out via the Redis adapter).

### Client

- Constants → state/ref: free. `checkRateLimit` reads a ref (same as reading a module constant).
- Limit OFF: `checkRateLimit` returns on the first line — **less** work than today.
- One extra `useEffect` syncing `messageLimit` → ref: fires only when the config actually changes (admin toggle / join), not per render.
- No new per-message sockets, Redis, or Mongo calls anywhere.

---

## 8. Files Changed

| Repo / File | Change |
|---|---|
| `football-chat-backend/utils/rate_limit_config.js` | **New.** `{enabled,max,windowSeconds}` config: `loadFromRedis`, `subscribeToChanges`, `getConfig`, `setConfig` (clamps to bounds), `onConfigChange`. |
| `football-chat-backend/config/redis.js` | + `rateLimitSubClient` (duplicate) for `__rate_limit_change__`; connect + export. |
| `football-chat-backend/server.js` | + `rateLimitConfig.loadFromRedis()` / `subscribeToChanges()` at boot; + re-hydrate on Redis `ready`. |
| `football-chat-backend/socket/socketHandler.js` | (1) import `getConfig`/`onConfigChange` from `rate_limit_config`; **remove the now-unused `getCurrentPerformanceMode` import**. (2) `onRateLimitChange` → `io.local.emit("rate_limit_changed", cfg)`. (3) `join_result.rateLimit = getRateLimitConfig()`. (4) `room_message`: read config, gate the incr/expire/ttl pipeline on `enabled && ip`, use `max`/`windowSeconds`. |
| `football-chat-backend/modules/chat/controller.js` | + `setRateLimitConfigController` (validates types; setConfig clamps), `getRateLimitConfigController`. |
| `football-chat-backend/modules/chat/index.js` | + `POST /set-rate-limit-config`, `POST /get-rate-limit-config` (both `isAdminKeyCorrect`). |
| `football-backend/utils/socket_apis_endpoints.js` | + `setRateLimitConfig`, `getRateLimitConfig` URLs. |
| `football-backend/utils/socket_api_calls.js` | + `setRateLimitConfigApiCall`, `getRateLimitConfigApiCall` (inject `adminKey`). |
| `football-backend/modules/match/controller.js` | + proxy controllers for set/get rate-limit config. |
| `football-backend/modules/match/index.js` | + `POST /set-rate-limit-config`, `GET /get-rate-limit-config` (`isAdmin, isUserLoggedIn`). |
| `football-admin/src/utils/axios.ts` | + `matches.setRateLimitConfig`, `matches.getRateLimitConfig`. |
| `football-admin/.../matches-list-view.tsx` | + `rateLimit` state + modal state; + `getRateLimit` loader (called on mount); + toggle/save handlers; + Switch with live `(max/windowSeconds s)` label; + edit `IconButton`; + `ConfirmDialog` with two bounded number fields. |
| `football-next-score8o8/.../chatBox.tsx` | Replace `MESSAGES_LIMIT`/`LIMIT_SECONDS` constants with `messageLimit` state + ref; `checkRateLimit` short-circuits when disabled & reads dynamic values; read `join_result.rateLimit`; + `rate_limit_changed` listener; `applyRateLimit` clears a stranded cooldown on disable. |
| `football-chat-backend/utils/perfomance_config.js` | **Remove** `rateLimitMax` + `rateLimitWindowSeconds` from all three performance modes (`normal` / `peak` / `extreme`). They were consumed only by the `room_message` rate-limit pipeline, which now reads `rate_limit_config`. No other reader exists, so removal is safe. |

---

## 9. Socket Events / Endpoints Reference

| Name | Direction / Type | Payload | When |
|---|---|---|---|
| `join_result` (extended) | server → client | `{ success, …, validation, rateLimit: {enabled,max,windowSeconds} }` | Reply to `join_room` |
| `rate_limit_changed` (new) | server → client (per-instance broadcast) | `{ enabled, max, windowSeconds }` | Admin changes config |
| `server_rate_limit` (existing) | server → client | `{ message, retryAfter }` | Unchanged — only emitted while the limit is enabled |
| `POST /set-rate-limit-config` (new) | admin → chat backend (via proxy) | `{ enabled?, max?, windowSeconds? }` (partial) | Admin toggle or modal Save |
| `POST /get-rate-limit-config` (new) | admin → chat backend (via proxy) | — | Admin dashboard load |

All additive — no renamed/removed fields, no breaking changes.

---

## 10. Rollout Order

1. **Chat backend** — additive (new module, routes, socket fields/event). Old clients/proxy ignore the new pieces. Default `enabled:true, 1/5` = current behavior. Deploy first.
2. **Middle backend (`football-backend`)** — additive proxy endpoints. Deploy second.
3. **Admin UI (`football-admin`)** — surfaces the toggle + edit modal. Deploy third.
4. **Chat client (`football-next-score8o8`)** — picks up config on join + real time. Deploy last (or any time — it's backward/forward compatible).

Each step is independently deployable and reversible. At no point does the live rate-limit behavior change until an admin actually edits it.

---

## 11. Open / Deferred

- **Per-IP vs per-tab semantics unchanged.** Backend limits per-IP (Redis `ratelimit:{ip}`); client limits per-tab (in-component timestamps). The admin numbers apply to both layers. Multi-tab users from one IP still share the server-side counter, as today.
- **No audit log** of who changed the limit / when. Out of scope; add later if needed.
- **Bounds (`1–100`, `1–3600`)** are enforced server-side authoritatively. If product wants different ceilings, change `MAX_BOUND`/`WINDOW_BOUND` in `rate_limit_config.js` (and the matching `inputProps` + Yup schema in the admin modal).

---

# Implementation Notes — 2026-06-07

**Status:** Implemented across all four repos. Backend `node --check` clean on all 11 touched JS files; `football-admin` and `football-next-score8o8` both `npx tsc --noEmit` → exit 0.

## What was implemented

Matches §1–§5. Concrete outcomes per repo:

### `football-chat-backend`
- **New** `utils/rate_limit_config.js` — `{ enabled, max, windowSeconds }` in Redis key `__rate_limit_config__`; `__rate_limit_change__` pub/sub; `onConfigChange` listener registry; `loadFromRedis` / `subscribeToChanges` / `getConfig` / `setConfig` / `DEFAULTS`. `setConfig` merges a partial onto current, clamps `max`→[1,100] / `windowSeconds`→[1,3600] via `clampInt`, notifies listeners synchronously, then SET + PUBLISH. `applyConfig` merges full messages onto `DEFAULTS`. Listener errors caught + logged.
- `config/redis.js` — added `rateLimitSubClient` (duplicate), error handler, `connectRedis()` Promise.all entry, and export.
- `server.js` — `require` of the module; `loadFromRedis()` + `subscribeToChanges()` right after the feature-flags boot; re-hydrate in the `pubClient.on("ready")` block.
- `socket/socketHandler.js` — (1) imported `getConfig`/`onConfigChange`; **removed the now-dead `getCurrentPerformanceMode` import**. (2) `onRateLimitChange` → `io.local.emit("rate_limit_changed", cfg)`. (3) `join_room` success attaches `result.rateLimit = getRateLimitConfig()`. (4) `room_message` reads `rl = getRateLimitConfig()`, `rateLimitActive = rl.enabled && !!ip` gates the `incr`/`expire`/`ttl` pipeline commands and both the rejection (`count > rl.max`) and at-cap (`count === rl.max`) branches.
- `utils/perfomance_config.js` — removed `rateLimitMax` + `rateLimitWindowSeconds` from `normal`/`peak`/`extreme`, with a comment that the rate limit now lives in `rate_limit_config.js`. `getCurrentPerformanceMode` still exported (other modules use it for batch/cache/debounce).
- `modules/chat/controller.js` — `setRateLimitConfigController` (type-validates `enabled`/`max`/`windowSeconds`, delegates clamping to `setConfig`) + `getRateLimitConfigController`; both exported.
- `modules/chat/index.js` — `POST /set-rate-limit-config` + `POST /get-rate-limit-config`, both `isAdminKeyCorrect`. Reachable through the proxy via the `/api/next/chat` + `/api/chat/chat` dual mount.

### `football-backend` (proxy tier)
- `utils/socket_apis_endpoints.js` — `setRateLimitConfig` + `getRateLimitConfig` URLs (`/api/next/chat/...`).
- `utils/socket_api_calls.js` — `setRateLimitConfigApiCall(payload)` (spreads payload + `adminKey`) + `getRateLimitConfigApiCall()`; both POST to the chat backend; exported. Partial merges work across the proxy because `JSON.stringify` drops `undefined` fields, so a toggle sends only `{ enabled }` and the modal only `{ max, windowSeconds }`.
- `modules/match/controller.js` — proxy controllers `setRateLimitConfigController` / `getRateLimitConfigController`; imports + exports updated.
- `modules/match/index.js` — `POST /set-rate-limit-config` + `GET /get-rate-limit-config` (`isAdmin, isUserLoggedIn`).

### `football-admin`
- `src/utils/axios.ts` — `matches.setRateLimitConfig` + `matches.getRateLimitConfig`.
- `matches-list-view.tsx` — `rateLimit` state (`enabled: null` until loaded) + `rateLimitModal` (`useBoolean`); `getRateLimit` loader added to the mount effect; `handleRateLimitToggle` (optimistic + rollback); **Message Limit Switch** with a live `(max/windowSeconds s)` label + edit `IconButton`; the `ConfirmDialog` edit modal (see deviation below).

### `football-next-score8o8`
- `chatBox.tsx` — removed the `MESSAGES_LIMIT` / `LIMIT_SECONDS` module constants (kept `STORE_MESSAGES_LIMIT`); added `messageLimit` state `{ enabled, max, windowSeconds }` (default `true, 1, 5`) + a `messageLimitRef` mirror synced via `useEffect`; `checkRateLimit` short-circuits when disabled and reads the ref; `applyRateLimit` sets state and clears a stranded cooldown on disable; `join_result` typed with `rateLimit?` and calls `applyRateLimit`; new `rate_limit_changed` listener.

## Deviations from the plan

- **Admin edit-modal validation (§4.2).** Planned as plain `TextField`s with a silent client-side clamp (`Math.min(Math.max(...))`) on Save. Changed to match the codebase convention used by the other modals in this view — **React Hook Form + Yup**:
  - New `editMessageLimitSchema` (next to `setTimeSchema`):
    ```ts
    const editMessageLimitSchema = Yup.object().shape({
      max: Yup.number().typeError('Must be a number').integer('Must be a whole number')
        .min(1, 'Must be at least 1').max(100, 'Cannot exceed 100').required('Messages allowed is required'),
      windowSeconds: Yup.number().typeError('Must be a number').integer('Must be a whole number')
        .min(1, 'Must be at least 1 second').max(3600, 'Cannot exceed 3600 seconds (1 hour)').required('Window is required'),
    });
    ```
  - `methodsRateLimit = useForm({ resolver: yupResolver(editMessageLimitSchema), defaultValues: { max: 1, windowSeconds: 5 } })`; the edit `IconButton` calls `resetRateLimit({ max, windowSeconds })` before opening; the modal body is a `FormProvider` + two `RHFTextField`s (`name="max"` / `name="windowSeconds"`), each with the range as default `helperText` (replaced by the inline error when invalid); the Save `LoadingButton` calls `onSubmitRateLimit = handleSubmitRateLimit(async (data) => …)` and shows `isSubmittingRateLimit`.
  - Result: out-of-range input (e.g. `25000`, `36000000`) now renders the inline error under the field and **blocks Save**, instead of being silently clamped. The `rateLimitDraft` / `isSavingRateLimit` state and the raw `TextField` import were removed.
  - The server-side clamp in `rate_limit_config.js` is retained as defense-in-depth (covers any request that bypasses the UI).

No other deviations. §1–§3, §5, and the perf/back-compat behavior shipped as written.

## Verification

- `node --check` on all 11 modified backend files (`football-chat-backend` ×7, `football-backend` ×4) → clean.
- `npx tsc --noEmit` in `football-admin` → exit 0 (re-run after the RHF refactor → still 0).
- `npx tsc --noEmit` in `football-next-score8o8` → exit 0.

## Deploy order

Unchanged — see §10: `football-chat-backend` → `football-backend` → `football-admin` → `football-next-score8o8`. Each is additive and independently deployable; live behavior is unchanged until an admin edits the config.

---

# Follow-up Fixes & Refinements — 2026-06-07

Post-implementation changes made during review/testing. All re-verified (`node --check` / `tsc --noEmit` exit 0).

## 1. Client: only record send timestamps while the limit is enabled (bug fix)

**Symptom (found in testing):** with the limit OFF, the user sends a message; the admin then turns the limit ON; the user's **next** send is blocked with the inline countdown — i.e. the *first* message under the newly-enabled limit was wrongly throttled.

**Root cause:** `handleSendMessage` pushed a timestamp into `messageTimestampsRef` on **every** send, including while the limit was off, and `applyRateLimit` only cleared that buffer on *disable*, not on *enable*. So an off-period send sat in the buffer and tripped `checkRateLimit` on the first send after enabling. This also diverged from the server, which never increments the per-IP counter while disabled — so the client was stricter than the server for no reason. (Latent side effect: while off, `checkRateLimit` returns before trimming, so the buffer grew unbounded.)

**Fix** ([chatBox.tsx](../football-next-score8o8/src/components/chatBox/chatBox.tsx)): guard the timestamp push with `messageLimitRef.current.enabled`, so the client records history **only while the limit is enabled** — mirroring the server. Result: after the admin enables the limit, the user's first message goes through, and the countdown appears *after* that send (correct "1 per 5s" behavior).

**Known narrow edge (accepted):** toggling OFF→ON again *within the window* after having sent under the limit can leave the server's per-IP Redis counter holding the earlier count until its TTL expires, so the server may briefly cooldown the next send even though the client allows it. Handled gracefully by the existing `server_rate_limit` signal; surfaces only under rapid toggle-spam, not normal use.

## 2. Redis key renamed to avoid the per-IP prefix

The config key was moved from `ratelimit:config` to **`__rate_limit_config__`** (cf. §1, §2.1). The original sat under the same `ratelimit:` prefix as the per-IP counters (`ratelimit:{ip}`); the new name uses the `__...__` control-plane convention (like `__perf_mode_current__`) so the config can never overlap that namespace. A comment in `rate_limit_config.js` records the rationale. No migration needed (feature not yet deployed); any leftover `ratelimit:config` key from earlier dev runs is orphaned and can be deleted.

## 3. Minor admin-modal cosmetics (consistency with the file's conventions)

- Modal open/close uses `useBoolean()` (`rateLimitModal.value/onTrue/onFalse`), matching the other dialogs in `matches-list-view.tsx` (`confirmSetTime`, `confirmAddCategory`) — the §4.2 snippets show a plain `useState`.
- Each field uses an `InputLabel` + `Typography` header above the `RHFTextField` with a `placeholder`, mirroring the Set-Time modal, rather than a floating MUI `label`.
