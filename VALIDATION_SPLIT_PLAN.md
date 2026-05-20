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
