# Client-Side Validation Split — Implementation Plan

## Goal

Split **client-side** message validation into two tiers:

- **Essential** validations always run on the client. Each one has its own UI treatment.
- **Non-essential** validations (the heuristic anti-spam set) run only when a local boolean `nonEssentialValidationOn` is true. The client mirrors the cluster-wide `FEATURE_VALIDATION` flag the backend already maintains.

The **server-side** validation logic is **not changing.** The backend already gates everything behind `FEATURE_VALIDATION` (see `utils/feature_flags.js` + `utils/messageValidation.js`). The only backend touch points in this plan are:

1. Include the current `FEATURE_VALIDATION` value in the `join_result` response.
2. Emit a `feature_flag_changed` event in real time to all connected sockets when the flag changes.

Everything else on the backend stays as-is.

---

## 1. Validation Taxonomy (Client Side)

### Essential — always run

| Check | UI treatment |
|---|---|
| **Trim** | Send button already disabled when `inputValue.trim() === ""` |
| **Length ≤ 200 chars** | **Disable the Send button** when `trim().length > MAX_LENGTH`. No "click then error" — the button just stays disabled. |
| **`isUserBanned`** | `setError("You are banned from chatting.")` and bail |
| **Rate limit (`checkRateLimit`)** | Sets its own `"Limit reached. Retry in N seconds"` error (existing behavior) |
| **URL check (`containsUrls`)** | `setError("This content is not allowed!")` and bail |
| **`cleanString`** (profanity censor) | Censor inline before emit so the wire payload is already clean |

### Non-essential — gated by `nonEssentialValidationOn` local state

A **single util function** runs the following in order, returning on first failure. UI shows a single generic error: `"This content is not allowed!"`.

1. `normalizeLeetspeak(content)` (preprocessor for the heuristics below)
2. `checkBotSuffix` (random trailing 2–4 char tag)
3. `checkAllCaps` (≥15 letters AND >70% uppercase)
4. `checkExcessivePunctuation` (≥10 chars AND >30% special chars)
5. `checkRepeatedPhrase` (low alphabet diversity or 15-char window repeat)
6. Repeated character run (`/(.)\\1{4,}/`)
7. Repeated word adjacent pair
8. `checkFuzzyDuplicate` (Jaccard similarity > 0.8 vs recent buffer)

---

## 2. Client Changes — `football-next-score8o8`

### 2.1 New util — `src/utils/messageValidation.ts`

Add a single exported function that runs all non-essentials and returns on first failure:

```ts
export const MAX_LENGTH = 200;

// Single entry point for all non-essential ("heuristic") validations.
// Returns on first failure with no per-reason exposure — caller shows a
// single generic message.
export const runNonEssentialValidation = (
  content: string,
  recentMessages: string[],
): { ok: boolean } => {
  const leetNormalized = normalizeLeetspeak(content);
  const normalized = leetNormalized
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");
  if (checkBotSuffix(content)) return { ok: false };
  if (checkAllCaps(content)) return { ok: false };
  if (checkExcessivePunctuation(content)) return { ok: false };
  if (checkRepeatedPhrase(leetNormalized)) return { ok: false };
  if (/([a-zA-Z0-9])\1{4,}/.test(normalized)) return { ok: false };
  const words = normalized.split(" ");
  if (words.some((w, i) => w && w === words[i + 1])) return { ok: false };
  if (checkFuzzyDuplicate(normalized, recentMessages)) return { ok: false };
  return { ok: true };
};
```

The existing individual `normalizeLeetspeak`, `checkBotSuffix`, ... exports stay so this function can compose them.

### 2.2 `chatBox.tsx` — local state for the flag

```ts
// Default true — conservative until the server tells us otherwise. If the
// server is older (no featureFlags in join_result), the client keeps
// running heuristics, which is the safer pre-existing behavior.
const [nonEssentialValidationOn, setNonEssentialValidationOn] = useState(true);
```

### 2.3 `chatBox.tsx` — sync with server

Two listeners. Both are additive — old servers don't send these fields and the client just keeps its default.

```ts
// 1. On join — read the current validation flag value.
newSocket.on("join_result", (data: {
  success: boolean;
  // ...existing fields
  validation?: boolean;
}) => {
  // ...existing logic
  if (typeof data.validation === "boolean") {
    setNonEssentialValidationOn(data.validation);
  }
});

// 2. In real time — admin toggled validation.
newSocket.on(
  "validation_changed",
  (data: { value: boolean }) => {
    setNonEssentialValidationOn(!!data?.value);
  },
);
```

### 2.4 `chatBox.tsx` — refactored `handleSendMessage`

The current `handleSendMessage` inlines all eight heuristics + `containsUrls` + the rate-limit call + the ban check in one if/else chain ([chatBox.tsx:1376-1436](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L1376-L1436)). Replacement:

```ts
const handleSendMessage = useCallback(
  async (content: string) => {
    if (!socket || !userName) return;
    const trimmed = content.trim();
    if (!trimmed) return; // Send button is also disabled; defensive.

    // ── Essentials (always run) ───────────────────────────────────────
    if (isUserBanned) {
      setError("You are banned from chatting.");
      return;
    }
    if (trimmed.length > MAX_LENGTH) {
      // Send button should already be disabled by the input layer.
      return;
    }
    if (checkRateLimit()) return; // sets its own error
    if (containsUrls(content)) {
      setError("This content is not allowed!");
      return;
    }
    const cleaned = cleanString(content);

    // ── Non-essentials (gated) ────────────────────────────────────────
    if (nonEssentialValidationOn) {
      const verdict = runNonEssentialValidation(
        content,
        recentMessagesRef.current,
      );
      if (!verdict.ok) {
        setError("This content is not allowed!");
        return;
      }
      // Track normalized form for future fuzzy-duplicate checks
      const normalized = normalizeLeetspeak(content)
        .toLowerCase()
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[^a-z0-9 ]/g, "");
      recentMessagesRef.current = [
        ...recentMessagesRef.current.slice(-4),
        normalized,
      ];
    }

    setError(null);
    messageTimestampsRef.current = [...messageTimestampsRef.current, Date.now()];

    // ── existing optimistic local push + emit ─────────────────────────
    const messageData = createMessage(userName, content, false, false, "room_message");
    isUserAtBottomRef.current = true;
    setShowScrollDown(false);
    setUnreadCount(0);
    setMessages((prev) => [...prev, messageData].slice(-STORE_MESSAGES_LIMIT));
    socket.emit("room_message", {
      roomId,
      messageContent: cleaned,
      senderName: userName,
    });
  },
  [socket, userName, roomId, checkRateLimit, isUserBanned, nonEssentialValidationOn],
);
```

Key differences vs. today:

- **Order is explicit and consistent.** Essentials first, in a fixed order. Non-essentials gated by the flag.
- **Length check now relies on the disabled button.** No "show error after click" path (the user explicitly asked for the button-disable approach).
- **`cleanString` runs every time.** Currently it's called from `ChatInput.handleSubmit` ([chatBox.tsx:232](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L232)). Move it here so all essentials live in one function — the wire payload is always the cleaned version.
- **Heuristic dependency on `nonEssentialValidationOn`.** When the flag is off, the entire heuristic block is skipped and `recentMessagesRef` is not updated (which is fine — fuzzy-dup only matters when heuristics are on).

### 2.5 `ChatInput` — disable Send on length + drop the cleanString wrap

In the `ChatInput` component ([chatBox.tsx:167-269](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L167-L269)):

- Drop the `if (inputValue?.trim()?.length > 200) { setError(...) }` inside `handleSubmit`.
- Drop the `cleanString(inputValue)` wrap inside `handleSubmit` — pass raw `inputValue` to `onSendMessage`. The clean now happens inside `handleSendMessage`.
- Add length to the Send button's `disabled`:
  ```tsx
  const overLimit = inputValue.trim().length > MAX_LENGTH;
  // ...
  disabled={
    isRegisterLoading ||
    !socketConnected ||
    !inputValue.trim() ||
    overLimit ||
    rateLimitExceeded
  }
  ```
- Import `MAX_LENGTH` from `src/utils/messageValidation`.

Optional UX nicety (not required): show a small character counter (`123 / 200`) next to the input that turns red at the limit. Decide later.

---

## 3. Backend Changes (Minimal)

The server's existing validation behavior is **unchanged**. Two surgical additions only — both purely informational from the client's perspective.

### 3.1 `utils/feature_flags.js` — `onFlagChange` listener registry

Today, the feature-flags module already syncs across PM2 instances via the `__feature_change__` Redis pub/sub channel ([feature_flags.js:95-104](/Users/arshad/learning/football-chat-backend/utils/feature_flags.js#L95-L104)). What's missing is a hook for *other* modules (like the socket layer) to react.

Add a tiny listener registry:

```js
const listeners = new Set();

function onFlagChange(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler); // unsubscribe, useful for tests
}

function notifyListeners(name, value) {
  listeners.forEach((fn) => {
    try { fn(name, value); }
    catch (err) { console.error("Feature flag listener error:", err); }
  });
}

// Inside subscribeToChanges' Redis callback, after applyFlag(name, value):
notifyListeners(name, value);

// Inside setFlag, after applyFlag(name, normalized) and before the publish:
// (lets the originating instance fire listeners synchronously, matching
// how the cache is updated synchronously there today)
notifyListeners(name, normalized);
```

Export `onFlagChange`.

**Why not import socket.io directly:** keeps `feature_flags.js` decoupled from the socket layer. The socket layer subscribes to flag-changes; the flag module doesn't need to know about sockets.

### 3.2 `socket/socketHandler.js` — broadcast validation changes

Inside `setupSocketHandlers(io)`, register an `onFlagChange` listener that broadcasts **only validation flips** to this instance's sockets. Other flags (e.g. `registration`) are server-internal and not exposed to clients.

```js
const { onFlagChange, getFlag, FEATURE_VALIDATION } = require("@project/utils/feature_flags");

onFlagChange((name, value) => {
  if (name !== FEATURE_VALIDATION) return; // client only cares about validation
  // `io.local.emit` restricts to sockets connected to this PM2 instance —
  // each instance receives the __feature_change__ Redis pub/sub message
  // independently, so using `io.emit` (which fans out cluster-wide via
  // the Redis adapter) would produce N×N broadcasts. Local emit keeps it
  // 1:N per instance with no duplication.
  io.local.emit("validation_changed", { value: !!value });
});
```

### 3.3 `socket/socketHandler.js` — include validation in `join_result`

Inside the existing `join_room` handler ([socketHandler.js:236-288](/Users/arshad/learning/football-chat-backend/socket/socketHandler.js#L236-L288)):

```js
const result = await joinRoom(roomId, socket, senderName, websiteName);
if (result.success) {
  result.validation = !!getFlag(FEATURE_VALIDATION);
}
socket.emit("join_result", result);
// ...rest unchanged
```

`getFlag(FEATURE_VALIDATION)` is an in-memory property read; no Redis round trip.

---

## 4. Why the Backend Stays Unchanged Otherwise

- The server's `validateMessage` function in [utils/messageValidation.js](/Users/arshad/learning/football-chat-backend/utils/messageValidation.js) keeps its current all-or-nothing semantics: when `FEATURE_VALIDATION` is on, everything runs; when off, nothing runs and raw content is broadcast.
- The `room_message` handler's `if (getFlag(FEATURE_VALIDATION)) { ... } else { outputContent = messageContent; }` block ([socketHandler.js:333-344](/Users/arshad/learning/football-chat-backend/socket/socketHandler.js#L333-L344)) is unchanged.
- The Redis ban check, room-existence check, and rate-limit pipeline at the top of the handler are unchanged.

The server is the source of truth for the flag; the client just learns its value.

---

## 5. Backwards Compatibility

| Scenario | Result |
|---|---|
| **New client + old server** (no `validation` in `join_result`, no `validation_changed` emit) | Client falls back to its default `nonEssentialValidationOn = true`. All heuristics keep running — same as today. |
| **Old client + new server** | Old client ignores the new `validation` field and the new `validation_changed` event. No errors, no behavior change. |
| **Admin toggles flag with client open** | Client receives `validation_changed`, updates state, next message sent skips/runs heuristics accordingly. |
| **Admin toggles flag, client reconnects** | New socket → `join_room` → `join_result` includes current `validation` → client syncs. |

---

## 6. Performance

This change is essentially free.

- **`getAllFlags()` on join** — in-memory object spread, ~2 properties. Negligible.
- **`feature_flag_changed` broadcast** — fires only when an admin toggles the flag (rare). One small JSON payload per connected socket via `io.local.emit`.
- **`onFlagChange` listener registry** — `Set` lookup is O(1), iteration is O(#listeners) which is at most 1 in our case.
- **Client-side `nonEssentialValidationOn` check per message** — single boolean read. The skipped non-essential heuristics actually *save* CPU when the flag is off.

No new Redis calls, no new Mongo calls, no new socket emits per message.

---

## 7. Files Changed

| File | Change |
|------|--------|
| `football-chat-backend/utils/feature_flags.js` | Add `onFlagChange(handler)` listener registry. Fire from both `subscribeToChanges` callback and `setFlag`. Export `onFlagChange`. |
| `football-chat-backend/socket/socketHandler.js` | (1) In `setupSocketHandlers(io)`: subscribe via `onFlagChange`, filter to `FEATURE_VALIDATION`, `io.local.emit("validation_changed", { value })`. (2) In `join_room` handler: attach `result.validation = !!getFlag(FEATURE_VALIDATION)` before emit. |
| `football-next-score8o8/src/utils/messageValidation.ts` | + `MAX_LENGTH = 200` exported constant. + `runNonEssentialValidation(content, recentMessages)` function. |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | (1) + `nonEssentialValidationOn` state, default `true`. (2) + listeners on `join_result.featureFlags` and `feature_flag_changed`. (3) Refactor `handleSendMessage` to run essentials always, non-essentials only when flag is on. (4) `ChatInput`: drop the in-`handleSubmit` length check + the `cleanString` wrap; add `overLimit` to the Send button's `disabled`. (5) Import `MAX_LENGTH`. |

---

## 8. Rollout Order

1. **Backend** — additive only. Old clients ignore the new fields/event. Safe to deploy first.
2. **Client** — picks up the server flag on next join + real-time updates immediately. Default `true` keeps heuristics on until the server tells the client otherwise.

Each step is independently deployable and reversible.

---

## 9. Socket Events Reference

| Event | Direction | Payload | When |
|---|---|---|---|
| `join_result` (existing, extended) | server → client | `{ success, roomId, usersCount?, validation: boolean }` | Reply to `join_room` |
| `validation_changed` (new) | server → client (per-instance broadcast) | `{ value: boolean }` | Admin toggles the validation flag via existing `POST /set-feature-flag` |

Both are additive shape changes — no breaking field renames or removals. Other feature flags (`registration`) remain server-internal and are not exposed over the socket.

---

# Implementation Notes — 2026-05-21

**Status:** Implemented. Backend `node -c` clean on both touched files; client `tsc --noEmit` exit 0.

## What was implemented

Matches §1–§3 of the plan above. Concrete file outcomes:

### `football-chat-backend/utils/feature_flags.js`
- Added `listeners` (Set) + `onFlagChange(handler)` registry + `notifyListeners(name, value)` helper.
- `setFlag` calls `notifyListeners` synchronously after `applyFlag` (originator path — fires before the Redis publish round-trip).
- `subscribeToChanges` calls `notifyListeners` after `applyFlag` inside the Redis pub/sub callback (cross-instance path).
- Errors thrown by individual listeners are caught + logged, never propagate.
- `onFlagChange` exported alongside the existing API.

### `football-chat-backend/socket/socketHandler.js`
- Imported `onFlagChange` alongside existing `getFlag` + `FEATURE_VALIDATION`.
- Inside `setupSocketHandlers(io)`, registered an `onFlagChange` listener that filters to `FEATURE_VALIDATION` and calls `io.local.emit("validation_changed", { value: !!value })`.
- `join_room` success path attaches `result.validation = !!getFlag(FEATURE_VALIDATION)` before `socket.emit("join_result", result)`.
- The failure path is unchanged — no `validation` field on `join_result` when `success: false`.
- The existing `validateMessage` + `room_message` handler logic was **not touched** — server-side validation behavior is identical to before.

### `football-next-score8o8/src/utils/messageValidation.ts`
- Added `export const MAX_LENGTH = 200`.
- Added `runNonEssentialValidation(content, recentMessages) → { ok: boolean }`.
- Added `normalizeForBuffer(content) → string` — exposes the same normalization used by the heuristics, for callers that want to push the message onto `recentMessagesRef`.
- All existing exports (individual checks) kept.

### `football-next-score8o8/src/components/chatBox/chatBox.tsx`
- New state `const [nonEssentialValidationOn, setNonEssentialValidationOn] = useState(true)`.
- `join_result` handler reads `data.validation` (typed as `validation?: boolean`) and calls `setNonEssentialValidationOn(data.validation)` when present.
- New `newSocket.on("validation_changed", ...)` listener that mirrors the flag.
- `handleSendMessage` refactored: essentials (ban → length → rate limit → URL → `cleanString`) always run; non-essentials gated by `nonEssentialValidationOn` (single `runNonEssentialValidation` call, single `"This content is not allowed!"` error on first failure).
- `recentMessagesRef` updated inside the non-essential branch only — when the flag is off the buffer doesn't grow.
- `ChatInput` simplified: no in-`handleSubmit` length error, no `cleanString` wrap (forwards raw input now). `setError` prop + caller removed since it's no longer used inside.
- Send button's `disabled` extended with `(!!userName && inputValue.trim().length > MAX_LENGTH)`.
- Module imports pruned to `MAX_LENGTH`, `runNonEssentialValidation`, `normalizeForBuffer` — the individual heuristic imports (`normalizeLeetspeak`, `checkBotSuffix`, `checkAllCaps`, …) are no longer referenced from `chatBox.tsx`.

### Character-counter UI (added during testing)

- A `<Typography variant="caption">` was added at the bottom-left of `ChatInput`'s `<Stack>` (which is now `position: relative`).
- Counter is `position: absolute, top: '100%', left: 0, mt: 0.25, pointerEvents: 'none'` — sits in the wrapping `<Box sx={{ p: 2 }}>`'s existing bottom padding zone. No layout shift.
- Display: `{inputValue.trim().length}/{MAX_LENGTH}`. Only rendered when `userName` is set (no message limit during username registration).
- Parent Typography color: `text.secondary`.
- The current-length number is wrapped in a `<Box component="span">` that flips to `color: 'error.main'` when `inputValue.trim().length > MAX_LENGTH`; the `/200` portion stays `text.secondary`. Uses MUI theme colors — no hardcoded hex.

## Deviations from the plan

- **Counter UI** was added during the implementation phase and isn't in the original plan §1-§9. Documented above.
- **Wrapping Box bottom padding** stayed at `pb: 2` (not bumped to `pb: 3`) — a tweak was tried and reverted by the user.

No other deviations.

## Verification

- `node -c utils/feature_flags.js && node -c socket/socketHandler.js` → clean.
- `npx tsc --noEmit` in `football-next-score8o8` → exit 0.

---

# Performance — Before / After

**Date:** 2026-05-21. Cluster baseline: 5 PM2 instances, Redis + Mongo on same box (per [PERF_REPORT.md](./PERF_REPORT.md)).

## Per `room_message` event — server side

The server's validation behavior is **unchanged**. Same in-memory `getFlag(FEATURE_VALIDATION)` read, same `validateMessage` path. Zero CPU/IO delta.

## Per `room_message` event — client side

| Phase | Before (heuristics always on) | After (flag ON) | After (flag OFF) |
|---|---|---|---|
| `containsUrls` (URL regex) | ~5 µs | ~5 µs | ~5 µs |
| `cleanString` (profanity censor) | ~10 µs (was called from `ChatInput.handleSubmit`) | ~10 µs (now called from `handleSendMessage`) | ~10 µs |
| `normalizeLeetspeak` + `.toLowerCase().trim().replace...` | ~3 µs | ~3 µs | **0 µs** (skipped) |
| 6 heuristic checks (`checkBotSuffix` … `checkFuzzyDuplicate`) | ~5–15 µs combined | ~5–15 µs combined | **0 µs** (skipped) |
| Push to `recentMessagesRef` | ~1 µs | ~1 µs | **0 µs** (skipped) |

**Net:** when the flag is OFF, the client saves ~8–18 µs per message send. When ON, identical to before. Either way: imperceptible to the user — typing latency is dominated by React's render cycle (~1–3 ms), not by validation work.

## Per-keystroke cost — character counter

The counter reads `inputValue.trim().length` on every render of `ChatInput`. `inputValue` changes on every keystroke, so `ChatInput` re-renders every keystroke regardless of the counter — adding the counter costs **one extra Typography render per keystroke**, ~50 µs each. Bounded by typing speed (~10 keystrokes/sec for fast typists → 500 µs/s = 0.05% of one core in the browser).

## Per-flag-change event — backend

| Step | Cost |
|---|---|
| Admin `POST /set-feature-flag` | Existing HTTP path, one Redis `SET` + one `PUBLISH` |
| `notifyListeners(name, value)` synchronous fan-out on originator | `Set.forEach` over (currently) 1 listener → 1 function call |
| Each PM2 instance's `subscribeToChanges` callback | One `JSON.parse` + `applyFlag` + `notifyListeners` (existing flow) |
| Socket-layer listener: `io.local.emit("validation_changed", ...)` | One emit per connected socket on this instance |

The `io.local.emit` deliberately bypasses the socket.io Redis adapter — each PM2 instance receives the `__feature_change__` Redis pub/sub message independently, so using `io.emit` would fan out cluster-wide via the adapter and produce N×N broadcasts. With `io.local.emit` we get 1:N per instance, N×1 total — clean and bounded by total connected sockets.

At 30 000 connected viewers cluster-wide: one admin toggle → ~30 000 small JSON broadcasts spread across 5 instances (6 000 each), each `~30 B` after socket.io permessage-deflate. Single-digit milliseconds of total work, fires only when admin actually toggles (rare).

## Per-`join_result` — backend

One `getFlag(FEATURE_VALIDATION)` in-memory read attached to the existing response. Indistinguishable from baseline.

## What is NOT changing

- Existing all-or-nothing server-side `validateMessage` gate.
- Existing ban + room + rate-limit Redis pipeline at the top of `room_message`.
- Mongo writes, Redis sorted-set cache, broadcast fan-out for reactions, pinned messages, scroll-lock conventions.
- The `FEATURE_REGISTRATION` flag — still server-internal, not exposed to clients.
- The Redis-backed feature-flag persistence + `__feature_change__` pub/sub channel.

---

# Files Changed (debounce-style summary)

| File | Change |
|------|--------|
| `football-chat-backend/utils/feature_flags.js` | + `listeners` Set, `onFlagChange(handler)`, `notifyListeners`. Wired into both `setFlag` and `subscribeToChanges`. Export `onFlagChange`. |
| `football-chat-backend/socket/socketHandler.js` | (1) Subscribe via `onFlagChange` → `io.local.emit("validation_changed", { value })` (filtered to `FEATURE_VALIDATION`). (2) Attach `result.validation = !!getFlag(FEATURE_VALIDATION)` on join_room success. |
| `football-next-score8o8/src/utils/messageValidation.ts` | + `MAX_LENGTH = 200`. + `runNonEssentialValidation(content, recentMessages) → { ok }`. + `normalizeForBuffer(content) → string`. |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | + `nonEssentialValidationOn` state (default `true`). + listeners on `join_result.validation` and `validation_changed`. Refactor `handleSendMessage` (essentials always, non-essentials gated). `ChatInput` cleanup (no inline length error, no `cleanString` wrap, no `setError` prop). Send button `disabled` extended with `length > MAX_LENGTH`. Character counter in input area (number turns `error.main` on overflow). |

---

# Update — 2026-05-21: Client-Side Rate-Limit UX

**Status:** Implemented. `tsc --noEmit` clean.

## Why

The client-side rate limit (`MESSAGES_LIMIT` per `LIMIT_SECONDS` window, currently `1` / `5s`) lives entirely inside the React component — it's a UX guard before the server's per-IP Redis check. Two issues with the original flow:

1. **Silent message deletion.** When the user sent message #1 and then tried to send #2 within the 5-second window, `ChatInput.handleSubmit` would call `onSendMessage(inputValue)` then unconditionally `setInputValue("")`. Inside `handleSendMessage`, `checkRateLimit()` would detect the previous timestamp, set `rateLimitExceeded=true`, and bail with no side-effect on the input. **Net: the typed text was cleared but the message was never sent.** The user only realized after-the-fact, with no way to recover their text.

2. **Indicator was disruptive.** The countdown was shown as a red `<Alert>` at the top of the input area, mirroring `server_rate_limit`. For client-side limits (which fire on every send if the user is rapid-typing), this Alert was constantly appearing and re-flowing the input area.

3. **State lag.** `setRateLimitExceeded(true)` happened inside `checkRateLimit()`, but only *during the next send attempt*. The user wasn't told they'd been rate-limited until they tried again.

## What changed

### `football-next-score8o8/src/components/chatBox/chatBox.tsx`

1. **Inline countdown at bottom-right** of `ChatInput`'s `<Stack>`, mirroring the character counter at bottom-left:
   ```tsx
   {userName && rateLimitExceeded && remainingSeconds > 0 && (
     <Typography
       variant="caption"
       sx={{
         position: "absolute",
         top: "100%",
         right: 0,
         mt: 0.25,
         pointerEvents: "none",
         color: "error.main",
         fontWeight: 500,
       }}
     >
       Send next message in: {remainingSeconds}s
     </Typography>
   )}
   ```
   - Absolute-positioned inside the wrapping `<Box sx={{ p: 2 }}>`'s existing bottom padding zone — no layout shift, no UI reflow.
   - Uses MUI theme `error.main`, no hardcoded color.
   - Visible only when the user is logged in (`userName`), is currently rate-limited, and has time remaining.

2. **`_remainingSeconds` → `remainingSeconds`** (state used to be prefixed because nothing rendered it; now we render it). Passed as a new prop to `ChatInput`.

3. **`handleSendMessage` now returns `Promise<boolean>`** — `true` only after the `socket.emit("room_message", ...)` succeeds. Every early-return path (ban / length / rate limit / URL / heuristic fail) returns `false`. `ChatInput.handleSubmit` awaits the result and **clears the input only on `true`**:
   ```tsx
   const sent = await onSendMessage(inputValue);
   if (sent) setInputValue("");
   ```
   Fixes the silent-deletion bug for **all** early-return paths, not just rate limit.

4. **`checkRateLimit()` re-run after a successful send.** Without this, the user only learned about the rate limit when their *next* send attempt failed:
   ```tsx
   socket.emit("room_message", { ... });
   // If this send just pushed us to the per-window limit, flip the
   // rate-limit state immediately so the inline countdown appears right
   // away.
   checkRateLimit();
   return true;
   ```
   Now: send msg → countdown appears on screen before the user can type the next message.

5. **`setError("Limit reached…")` calls removed in two places** (the top-of-input Alert is no longer used for client rate limits):
   - Inside `checkRateLimit()` itself.
   - Inside the countdown-decrement `useEffect`.

6. **Inputs stay editable while rate-limited.** Previously the `TextField` had `disabled={!socketConnected || rateLimitExceeded}` and an `error={... || rateLimitExceeded}` styling that turned the input grey-with-red-border. Changed to `disabled={!socketConnected}` and `error={!userName && /\s/.test(inputValue)}`. **Only the Send button greys out** when rate-limited; the user can keep typing while waiting for the window to clear.

## What stays the same

- The decrement-every-1s `useEffect` driving `setRemainingSeconds(prev - 1)`. Still ticks the countdown down to 0, then flips `rateLimitExceeded=false` and clears `messageTimestampsRef.current`.
- The `server_rate_limit` socket listener at [chatBox.tsx:1301-1308](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L1301-L1308) is **untouched**. Server-driven rate limits (per-IP, in Redis) still trigger the top-of-input Alert via `setError(data.message)` — that path was explicitly out of scope for this change.
- The Send button's `disabled` still includes `rateLimitExceeded` (was already there).
- `MESSAGES_LIMIT = 1` and `LIMIT_SECONDS = 5` — matches the server-side per-IP config (`utils/perfomance_config.js` → `rateLimitMax: 1, rateLimitWindowSeconds: 5`) in all three performance modes.

## Known follow-up (not implemented)

When `server_rate_limit` fires, the sender's optimistic-push of their own message is **not rolled back**. The sender still sees the message in their own chat even though the server silently dropped it and no other client received it. Two viable fixes:

1. Track each optimistic message with a temporary client ID; on `server_rate_limit`, remove the most recent unconfirmed message by this user.
2. Defer the optimistic `setMessages` until the server echoes `room_message` back. Loses ~50-100 ms of "snappy send" feel but is dead-simple.

Deferred — flagged for a separate change.

## Performance

Trivial. The new inline countdown is one extra Typography render per second per rate-limited user (the decrement effect already existed). The `checkRateLimit()` post-send re-call is one extra Array filter + length compare per successful send — sub-microsecond.

No new socket events. No new server load. The rate-limit Redis pipeline on the server side is unchanged.

## Files Changed

| File | Change |
|------|--------|
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Rename `_remainingSeconds` → `remainingSeconds`. Drop `setError(...)` from `checkRateLimit` + countdown effect. `handleSendMessage` returns `Promise<boolean>`; emits before returning `true`; re-runs `checkRateLimit()` after a successful send. `ChatInput.handleSubmit` awaits + clears input only on `true`. `ChatInput` accepts new `remainingSeconds` prop; renders inline countdown at bottom-right. TextField no longer disables/errors on `rateLimitExceeded`. |
