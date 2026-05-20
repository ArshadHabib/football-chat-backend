# Admin Multi-Reactions — Implementation Plan

## Goal

Let admins react **multiple times** to any chat message with any allowed emoji, inflating the visible reaction count clients see. From a regular client's perspective the message looks like many users reacted to it. From the admin's perspective there is a picker (click `+`) and a hover-controlled `-` / `+` panel on each existing pill to adjust their own counter.

Three projects:
- `football-chat-backend` — new socket events + new data field + flush/Redis sync
- `football-admin` — picker UI + hover tooltip UI (write path)
- `football-next-score8o8` — read-only render of the inflated count (no UI change of behavior)

---

## 1. DATA MODEL

### New field on `Message`

Today:
```js
reactions: { type: Map, of: [String], default: {} }   // emoji -> [usernames]
```

Add:
```js
adminReactions: { type: Map, of: Number, default: {} } // emoji -> count
```

Why a **count** (not an array of admin usernames):
- The requirement is a single shared counter per emoji per message — every admin click increments it, every admin minus-click decrements it. Whether two different admins did it doesn't matter; the visible-to-client effect is identical.
- A `Number` is mergeable across PM2 instances via Mongo `$inc` (atomic, conflict-free). An array of fake names would either need ever-growing strings or fight `$set` against itself.
- Storage is O(emojis) per message instead of O(clicks).

### Why keep `reactions` and `adminReactions` separate

- `reactions` keeps its current semantics: real-user reactions, one per user per message, used for highlighting "you reacted with X".
- `adminReactions` is purely additive count. It never affects highlight logic on the client side.
- Final displayed count on every client = `realUsers.length + (adminReactions[emoji] || 0)`.

### Allowed emojis

Reuse the existing constant — no new emojis:
```js
const ALLOWED_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢", "😡"];
```

---

## 2. SOCKET EVENTS

| Event | Direction | Payload | Auth |
|---|---|---|---|
| `admin_add_reaction` | admin → server | `{ roomId, messageId, emoji }` | `socket.isAdmin` required |
| `admin_remove_reaction` | admin → server | `{ roomId, messageId, emoji }` | `socket.isAdmin` required |
| `message_reaction_updated` | server → room | `{ messageId, reactions, adminReactions }` | n/a (existing event, **payload extended**) |

### Why extend the existing `message_reaction_updated`

- Clients already subscribe to it. Adding the `adminReactions` field is additive; old clients ignore it (display unchanged, no admin inflation).
- Every reaction broadcast — whether from `add_reaction` (real user), `admin_add_reaction`, or `admin_remove_reaction` — emits the **full combined view** so listeners never need to merge deltas.

### `admin_add_reaction` flow

```js
socket.on("admin_add_reaction", async (data) => {
  if (!socket.isAdmin) {
    socket.emit("error", { message: "Admin access required" });
    return;
  }
  const { roomId, messageId, emoji } = data;
  if (!roomId || !messageId || !emoji) return;
  if (!ALLOWED_REACTIONS.includes(emoji)) return;

  try {
    const result = await applyAdminReactionService(messageId, emoji, +1);
    if (!result) return;
    io.to(roomId).emit("message_reaction_updated", {
      messageId,
      reactions: result.reactions,
      adminReactions: result.adminReactions,
    });
  } catch (err) {
    console.error("Admin reaction error:", err);
  }
});
```

`admin_remove_reaction` is identical with `-1` and a floor-at-0 guard inside the service.

### Auth — reuse the existing path

No new auth code. Just check `socket.isAdmin`, set by [socketHandler.js:99](/Users/arshad/learning/football-chat-backend/socket/socketHandler.js#L99) after `admin_authenticate` validates the JWT. Same check used by `admin_room_message`, `update_user`, `update_views_visibility`, etc. — keeps the convention consistent.

---

## 3. BACKEND — `applyAdminReactionService`

In `modules/chat/service.js`, parallel to `applyReactionService`:

```js
// Admin reaction batch — per-message per-emoji DELTA since last flush
// Map<messageId, Map<emoji, number>>
const adminReactionBatch = new Map();
// In-memory canonical snapshot of admin counts, used to broadcast and to
// floor decrements at zero without a DB round-trip
// Map<messageId, Map<emoji, number>>
const adminReactionSnapshot = new Map();

async function applyAdminReactionService(messageId, emoji, delta) {
  if (!mongoose.isValidObjectId(messageId)) return null;

  // Seed the snapshot from DB on first access (same lazy-load pattern as
  // applyReactionService). This also seeds `reactionBatch` so the combined
  // broadcast view stays consistent if a real-user reaction has not been
  // loaded yet for this messageId.
  if (!adminReactionSnapshot.has(messageId)) {
    const msg = await MessageModel.findById(messageId)
      .select("reactions adminReactions")
      .lean();
    const snap = new Map();
    if (msg?.adminReactions) {
      for (const [e, n] of Object.entries(msg.adminReactions)) {
        if (n > 0) snap.set(e, n);
      }
    }
    adminReactionSnapshot.set(messageId, snap);

    if (!reactionBatch.has(messageId)) {
      const rmap = new Map();
      if (msg?.reactions) {
        for (const [e, users] of Object.entries(msg.reactions)) {
          rmap.set(e, new Set(users));
        }
      }
      reactionBatch.set(messageId, rmap);
    }
  }

  const snap = adminReactionSnapshot.get(messageId);
  const current = snap.get(emoji) || 0;
  let appliedDelta = delta;

  if (delta < 0) {
    // Floor at 0 — admin pressed minus when count was already 0 (race).
    appliedDelta = -Math.min(-delta, current);
    if (appliedDelta === 0) {
      // No-op: return current state so caller still broadcasts (cheap, keeps
      // all clients converged if they were out of sync)
      return serializeCombined(messageId);
    }
  }

  snap.set(emoji, current + appliedDelta);
  if (snap.get(emoji) <= 0) snap.delete(emoji);

  // Accumulate delta for the flush
  const deltaMap = adminReactionBatch.get(messageId) || new Map();
  deltaMap.set(emoji, (deltaMap.get(emoji) || 0) + appliedDelta);
  if (deltaMap.get(emoji) === 0) deltaMap.delete(emoji);
  if (deltaMap.size === 0) adminReactionBatch.delete(messageId);
  else adminReactionBatch.set(messageId, deltaMap);

  dirtyMessageIds.add(messageId);
  return serializeCombined(messageId);
}

function serializeCombined(messageId) {
  const reactions = {};
  const rmap = reactionBatch.get(messageId);
  if (rmap) {
    rmap.forEach((users, e) => {
      if (users.size > 0) reactions[e] = Array.from(users);
    });
  }
  const adminReactions = {};
  const snap = adminReactionSnapshot.get(messageId);
  if (snap) {
    snap.forEach((n, e) => {
      if (n > 0) adminReactions[e] = n;
    });
  }
  return { reactions, adminReactions };
}
```

### Why `$inc` (not `$set`) for `adminReactions`

PM2 multi-instance safety:
- Real-user `reactions` uses `$set` per-emoji because each instance owns the full Set (one-per-user model) — overwriting its own emoji slot is correct.
- Admin counters are **shared, additive**. Two instances both flushing `+3` and `+2` simultaneously must result in `+5`, not `+3`. `$inc` is atomic in Mongo and merges naturally.

### Update `flushReactionBatch`

The existing flush handles real-user `reactions` via `$set`/`$unset`. Extend it to also apply `$inc` for `adminReactions` deltas in the **same `updateOne` call** (so each messageId still flushes in one round trip):

```js
for (const messageId of ids) {
  const reactions = reactionBatch.get(messageId);
  const adminDeltas = adminReactionBatch.get(messageId);
  if (!reactions && !adminDeltas) continue;

  const setFields = {};
  const unsetFields = {};
  const incFields = {};

  reactions?.forEach((users, emoji) => {
    if (users.size > 0) setFields[`reactions.${emoji}`] = Array.from(users);
    else unsetFields[`reactions.${emoji}`] = "";
  });
  adminDeltas?.forEach((delta, emoji) => {
    if (delta !== 0) incFields[`adminReactions.${emoji}`] = delta;
  });

  const update = {};
  if (Object.keys(setFields).length) update.$set = setFields;
  if (Object.keys(unsetFields).length) update.$unset = unsetFields;
  if (Object.keys(incFields).length) update.$inc = incFields;

  // ... existing updateOne + matchedCount retry logic, identical to today
}
```

### Clear admin delta after successful flush

```js
if (result.matchedCount > 0) {
  // ... existing reaction cleanup
  adminReactionBatch.delete(messageId); // deltas are consumed
  // Re-read canonical adminReactions so the snapshot reflects merged increments
  // from other PM2 instances (same reasoning as the existing canonical re-read
  // for `reactions`)
  const canonical = await MessageModel.findById(messageId)
    .select("reactions adminReactions roomId")
    .lean();
  if (canonical?.roomId) {
    // Refresh in-memory snapshot from canonical
    const snap = new Map();
    if (canonical.adminReactions) {
      for (const [e, n] of Object.entries(canonical.adminReactions)) {
        if (n > 0) snap.set(e, n);
      }
    }
    adminReactionSnapshot.set(messageId, snap);
    if (snap.size === 0 && !adminReactionBatch.has(messageId)) {
      adminReactionSnapshot.delete(messageId);
    }
    await updateReactionInSortedSet(
      String(canonical.roomId),
      messageId,
      canonical.reactions,
      canonical.adminReactions,
    );
  }
}
```

### Floor floor-at-zero on flush

If concurrent `-1`s from two instances over-decrement, the in-memory floor catches it locally but the Mongo `$inc -1` could drive `adminReactions.<emoji>` below zero. After the canonical re-read, if any emoji is `<= 0`, issue a compensating `updateOne` that `$max`s it to 0 — or, simpler, on read every client/admin always treats negative as 0 (defensive). I prefer the defensive read approach since the floor is already enforced at the in-memory layer for the common case.

---

## 4. REDIS SORTED-SET SYNC

The existing Lua script `REACTION_SORTED_SET_SCRIPT` patches `reactions` on the cached message. Extend it to also patch `adminReactions`:

```lua
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
for i, val in ipairs(members) do
  local ok, decoded = pcall(cjson.decode, val)
  if ok and tostring(decoded['_id']) == ARGV[1] then
    local score = redis.call('ZSCORE', KEYS[1], val)
    local ok2, newReactions = pcall(cjson.decode, ARGV[2])
    if ok2 then decoded['reactions'] = newReactions end
    local ok3, newAdmin = pcall(cjson.decode, ARGV[3])
    if ok3 then decoded['adminReactions'] = newAdmin end
    redis.call('ZREM', KEYS[1], val)
    redis.call('ZADD', KEYS[1], tonumber(score), cjson.encode(decoded))
    return 1
  end
end
return 0
```

Update `updateReactionInSortedSet(roomId, messageId, reactionsFromDb, adminReactionsFromDb)` to pass the third arg. Atomicity preserved — single `EVAL`, single ZREM/ZADD pair, no cross-instance race on the same message.

### History load — `getChatHistory`

Wherever the API/socket returns message history (the REST endpoint that `chat-table-rows.tsx` and `chatBox.tsx` both call), make sure the `adminReactions` field is included in the projection / lean select. Mongoose `Map<Number>` serializes to a plain object in `.lean()` automatically.

---

## 5. CLIENT — `football-next-score8o8/src/components/chatBox/chatBox.tsx`

Almost zero behavior change. Two surgical edits:

### A. Extend `MessageNew`

```ts
interface MessageNew {
  // ...existing...
  reactions?: Record<string, string[]>;
  adminReactions?: Record<string, number>;
}
```

### B. Inflate the displayed count in the pill render

Currently at [chatBox.tsx:464-498](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L464-L498):

```ts
{msg.reactions &&
  Object.entries(msg.reactions).map(([emoji, users]) =>
    users.length > 0 ? (
      // ...
      <span>{emoji}</span>
      {users.length > 1 && <span>{users.length}</span>}
    ) : null,
  )}
```

Becomes:

```ts
{
  // Compose the set of emojis we need to render: union of real and admin.
  // Real users iterate first to keep emoji order stable; admin-only emojis
  // get appended afterwards.
  const realEntries = Object.entries(msg.reactions || {});
  const adminEntries = Object.entries(msg.adminReactions || {});
  const seen = new Set(realEntries.map(([e]) => e));
  const emojiOrder = [
    ...realEntries.map(([e]) => e),
    ...adminEntries.filter(([e]) => !seen.has(e)).map(([e]) => e),
  ];
  return emojiOrder.map((emoji) => {
    const users = msg.reactions?.[emoji] || [];
    const adminN = msg.adminReactions?.[emoji] || 0;
    const total = users.length + adminN;
    if (total === 0) return null;
    return (
      <Box key={emoji} /* ... existing styles ... */>
        <span>{emoji}</span>
        {total > 1 && <span>{total}</span>}
      </Box>
    );
  });
}
```

Highlighting (`users.includes(reactingAs)`) is unchanged — a real client never "owns" any admin reactions. Click-pill-to-toggle stays unchanged — `emitReaction(emoji, msg._id)` only touches the real-user side, and admin counts persist independently.

`message_reaction_updated` listener at [chatBox.tsx:1008-1018](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L1008-L1018) needs to spread the new field:

```ts
newSocket.on("message_reaction_updated", (data) => {
  isReactionUpdateRef.current = true;
  setMessages((prev) =>
    prev.map((msg) =>
      msg._id === data.messageId
        ? { ...msg, reactions: data.reactions, adminReactions: data.adminReactions }
        : msg,
    ),
  );
});
```

Scroll lock — no change needed; `isReactionUpdateRef` already covers it.

### Optimistic update

The optimistic update in `emitReaction` (real-user side) builds a fresh `reactions` object but doesn't touch `adminReactions`. To avoid wiping admin counts during the optimistic window, preserve them:

```ts
return { ...msg, reactions, adminReactions: msg.adminReactions };
```

(Spread already handles this — explicit only for clarity.)

---

## 6. ADMIN — `football-admin/src/sections/matches/chat-table-rows.tsx`

This is the only project that gets net-new UI: a picker and a hover-controlled +/- panel.

### Imports — add `Popover` and `Tooltip` (already imported)

```tsx
import { Popover } from '@mui/material';
```

### State

```tsx
const ALLOWED_REACTIONS = ['👍', '👎', '❤️', '😂', '😮', '😢', '😡'];

// Picker (the `+` smiley → emoji-grid Popover, same as client)
const [pickerAnchor, setPickerAnchor] = useState<{
  el: HTMLElement;
  messageId: string;
} | null>(null);

// Hover panel (existing pill → -/emoji/+ Popover)
const [hoverPanel, setHoverPanel] = useState<{
  el: HTMLElement;
  messageId: string;
  emoji: string;
} | null>(null);
const hoverCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
```

### Reuse the scroll-lock pattern

`chat-table-rows.tsx` already has `isPopoverOpenRef` for `ChatUserName` ([chat-table-rows.tsx:185](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L185)) and `isReactionUpdateRef` for incoming reaction updates ([chat-table-rows.tsx:187](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L187)). The auto-scroll effect at [chat-table-rows.tsx:351-365](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L351-L365) already bails when either is true.

So when opening the picker OR the hover panel, set `isPopoverOpenRef.current = true`; reset to `false` on close. Same convention as the existing `ChatUserName` integration ([chat-table-rows.tsx:549](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L549)). No new lock primitive.

### Emit helpers

```tsx
const emitAdminAdd = useCallback((emoji: string, messageId: string) => {
  if (!socket || !isAuthenticated) return;
  socket.emit('admin_add_reaction', { roomId, messageId, emoji });
}, [socket, isAuthenticated, roomId]);

const emitAdminRemove = useCallback((emoji: string, messageId: string) => {
  if (!socket || !isAuthenticated) return;
  socket.emit('admin_remove_reaction', { roomId, messageId, emoji });
}, [socket, isAuthenticated, roomId]);
```

**No optimistic update on admin side.** Reason: admin clicks can be rapid-fire (the whole point is to spam reactions), and the server-side flush is fast enough (1/3/5s perf mode) that the canonical broadcast feels live. An optimistic counter would diverge from the canonical view when multiple admins react simultaneously, and reconciling that mid-stream is fiddly. The broadcast round-trip is ~50-100ms — fine.

If latency proves visible, add the same optimistic pattern as the client side (`isReactionUpdateRef` gate, increment local state, let server echo confirm).

### Picker button on each message (the smiley `+`)

In the existing message render block ([chat-table-rows.tsx:528-637](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L528-L637)), add an `IconButton` next to the reaction pills row — matching the client's pattern at [chatBox.tsx:499-518](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L499-L518):

```tsx
<Tooltip title="Add reaction" arrow disableFocusListener disableInteractive>
  <IconButton
    size="small"
    onClick={(e) => {
      isPopoverOpenRef.current = true;
      setPickerAnchor({ el: e.currentTarget, messageId: msg._id! });
    }}
  >
    <Iconify icon="mdi:emoticon-plus-outline" width={18} />
  </IconButton>
</Tooltip>
```

### Picker `Popover` (mounted once at the bottom of the component)

```tsx
<Popover
  open={!!pickerAnchor}
  anchorEl={pickerAnchor?.el}
  onClose={() => {
    isPopoverOpenRef.current = false;
    setPickerAnchor(null);
  }}
  anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
  transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
>
  <Stack direction="row" gap={0.25} sx={{ p: 0.5 }}>
    {ALLOWED_REACTIONS.map((emoji) => (
      <IconButton
        key={emoji}
        size="small"
        onClick={() => {
          if (pickerAnchor) emitAdminAdd(emoji, pickerAnchor.messageId);
          // DO NOT close — admin can spam-click the same emoji
        }}
        sx={{ borderRadius: 2, transition: 'background-color 0.15s' }}
      >
        <Typography sx={{ fontSize: '1.25rem', lineHeight: 1 }}>{emoji}</Typography>
      </IconButton>
    ))}
  </Stack>
</Popover>
```

**Key difference from client picker**: this picker does NOT close on emoji click. Each click on the same emoji emits another `admin_add_reaction`. Admin closes manually by clicking outside (`onClose` fires). The client picker by contrast closes after one selection (toggle semantics, [chatBox.tsx:1235-1242](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L1235-L1242)).

### Hover panel on existing pills

Wrap the pill rendering in handlers:

```tsx
const openHoverPanel = (el: HTMLElement, messageId: string, emoji: string) => {
  if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
  isPopoverOpenRef.current = true;
  setHoverPanel({ el, messageId, emoji });
};

const scheduleHoverClose = () => {
  if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
  hoverCloseTimerRef.current = setTimeout(() => {
    isPopoverOpenRef.current = false;
    setHoverPanel(null);
  }, 150);
};

const cancelHoverClose = () => {
  if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
};
```

Pill (existing render at [chat-table-rows.tsx:610-633](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L610-L633)):

```tsx
<Box
  key={emoji}
  onMouseEnter={(e) => openHoverPanel(e.currentTarget, msg._id!, emoji)}
  onMouseLeave={scheduleHoverClose}
  sx={{ /* existing pill styles */ cursor: 'pointer' }}
>
  <span>{emoji}</span>
  {total > 1 && <span>{total}</span>}   {/* total = users.length + adminReactions[emoji] */}
</Box>
```

The 150ms close delay is the standard "hover bridge" pattern — gives the user time to move from pill into the panel without it disappearing. The panel itself mirrors `onMouseEnter`/`onMouseLeave` with the same `cancelHoverClose`/`scheduleHoverClose`.

### Hover `Popover` panel

```tsx
<Popover
  open={!!hoverPanel}
  anchorEl={hoverPanel?.el}
  onClose={() => {
    isPopoverOpenRef.current = false;
    setHoverPanel(null);
  }}
  anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
  transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
  // Crucial — let mouse hover stay registered, don't steal focus
  disableRestoreFocus
  sx={{ pointerEvents: 'none' }}
  PaperProps={{
    onMouseEnter: cancelHoverClose,
    onMouseLeave: scheduleHoverClose,
    sx: { pointerEvents: 'auto' },
  }}
>
  {hoverPanel && (() => {
    const msg = messages.find((m) => m._id === hoverPanel.messageId);
    const adminCount = msg?.adminReactions?.[hoverPanel.emoji] || 0;
    const canMinus = adminCount > 0;
    return (
      <Stack direction="row" alignItems="center" gap={0.5} sx={{ p: 0.5 }}>
        <IconButton
          size="small"
          disabled={!canMinus}
          onClick={() => emitAdminRemove(hoverPanel.emoji, hoverPanel.messageId)}
        >
          <Iconify icon="mdi:minus" width={18} />
        </IconButton>
        <Typography sx={{ fontSize: '1.25rem', lineHeight: 1, px: 0.5 }}>
          {hoverPanel.emoji}
        </Typography>
        <IconButton
          size="small"
          onClick={() => emitAdminAdd(hoverPanel.emoji, hoverPanel.messageId)}
        >
          <Iconify icon="mdi:plus" width={18} />
        </IconButton>
      </Stack>
    );
  })()}
</Popover>
```

### Disabling `-` per the spec

> if admin has reacted 0 time of that reaction than minus will not work

`disabled={!canMinus}` where `canMinus = (msg?.adminReactions?.[emoji] || 0) > 0`. The `-` button is greyed out and unclickable when admin's count for that emoji is 0. Since `adminReactions` is the **shared** admin counter (any admin can decrement it as long as the total is > 0), if a different admin had reacted you can still minus. That matches the spec's wording ("admin has reacted one time" — the admin collective, since there's only one shared admin counter per emoji).

### Wire up `message_reaction_updated` to include `adminReactions`

[chat-table-rows.tsx:316-323](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L316-L323):

```tsx
newSocket.on('message_reaction_updated', (data) => {
  isReactionUpdateRef.current = true;
  setMessages((prev) =>
    prev.map((msg) =>
      msg._id === data.messageId
        ? { ...msg, reactions: data.reactions, adminReactions: data.adminReactions }
        : msg,
    ),
  );
});
```

### Extend `MessageNew` interface

[chat-table-rows.tsx:34-44](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L34-L44):

```ts
interface MessageNew {
  // ...existing...
  adminReactions?: Record<string, number>;
}
```

### Update the pill render to use the combined count

[chat-table-rows.tsx:596-635](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L596-L635) — same union-of-emojis pattern as the score8o8 client (see §5.B above). Render only emojis with `total > 0`; show count only when `total > 1`.

### Cleanup on unmount

```tsx
useEffect(() => () => {
  if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
}, []);
```

---

## 7. AUTH / SECURITY

- The only writers are `admin_add_reaction` and `admin_remove_reaction`. Both check `socket.isAdmin` exactly like every other admin event in the file.
- `socket.isAdmin` is set only inside `admin_authenticate` after `authenticateToken(token)` returns `userRoleFromToken === "admin"` ([socketHandler.js:96-99](/Users/arshad/learning/football-chat-backend/socket/socketHandler.js#L96-L99)). Same JWT path as `admin_room_message`.
- Banned-user check is **not** applied to admins (admins can't be banned). Skipped here.
- No emoji outside `ALLOWED_REACTIONS` is accepted; silent reject (no echo, no broadcast) — same as `add_reaction` today.

---

## 8. CROSS-INSTANCE / PERFORMANCE CONSIDERATIONS

| Concern | Handling |
|---|---|
| Two PM2 instances flushing admin deltas for same message | `$inc` is atomic in Mongo, deltas merge; canonical re-read after flush refreshes in-memory snapshot |
| Admin clicks 50 times in 2s during peak mode (5s flush) | All 50 increments live in one in-memory delta; one `$inc: { 'adminReactions.👍': 50 }` flushed once |
| Admin double-clicks `-` at count=1 | First decrement applied; second decrement floored at 0 (in-memory check) → no broadcast suppression but `appliedDelta=0` so no $inc emitted |
| Admin reacts to message that's still in another instance's write batch | Same retry-up-to-10-cycles path as `applyReactionService` — the seed-from-DB fails, but in-memory snapshot is empty, increments accumulate, retries fire after Mongo write lands |
| Redis sorted-set cache and Mongo diverge | After every successful flush, canonical doc is re-read from Mongo and `updateReactionInSortedSet` patches both fields atomically via the Lua script — same convergence guarantee as real reactions today |
| History endpoint stale during the flush window | Same as today — Redis sorted set is patched after flush, so a history fetch right before flush sees the pre-flush state, right after sees the post-flush state. The in-memory snapshot + live socket broadcast cover the window for any connected user/admin |
| Memory growth from `adminReactionBatch` / `adminReactionSnapshot` | Same eviction pattern as `reactionBatch` — snapshot is cleared once the message has no pending deltas and the canonical state is empty; otherwise kept warm for fast subsequent reads |

---

## 9. FILES CHANGED

| File | Changes |
|---|---|
| `football-chat-backend/modules/chat/messageModel.js` | Add `adminReactions: { type: Map, of: Number, default: {} }` |
| `football-chat-backend/modules/chat/service.js` | New `applyAdminReactionService`; new `adminReactionBatch` + `adminReactionSnapshot`; extend `flushReactionBatch` with `$inc`; extend `updateReactionInSortedSet` signature + Lua script |
| `football-chat-backend/socket/socketHandler.js` | New `admin_add_reaction` and `admin_remove_reaction` handlers; extend `message_reaction_updated` payload from existing `add_reaction` handler to also emit `adminReactions` |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Extend `MessageNew`; combine real + admin counts in pill render; spread `adminReactions` in `message_reaction_updated` listener |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | Extend `MessageNew`; combined-count pill render; new picker button + Popover; new hover panel Popover with -/+/disabled-minus logic; emit helpers; spread `adminReactions` in `message_reaction_updated` listener |

---

## 10. NO-REGRESSION GUARANTEES

Every edit below was audited against the existing codepaths. The plan must not change observable behavior for code that doesn't touch admin reactions.

### 10.1 History endpoints — **zero changes required**

Both server-side history paths use `.lean()` with **no `.select()` projection**:
- `getRecentMessagesWithCache` ([service.js:454-457](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L454-L457))
- `retrieveRoomMessagesService` admin path ([service.js:488-491](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L488-L491))
- Pinned-message fetch ([service.js:506-509](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L506-L509))

→ The new `adminReactions` field is returned automatically. Redis sorted-set cache also returns full JSON. No history-path code edits.

### 10.2 The two projections that DO need extending

Both are inside `service.js` and used only for the reaction lazy-seed / canonical re-read:

| Today | After |
|---|---|
| `MessageModel.findById(messageId).select("reactions roomId").lean()` ([line 259-261](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L259-L261)) | `.select("reactions adminReactions roomId")` |
| `MessageModel.findById(messageId).select("reactions").lean()` ([line 294-295](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L294-L295)) | `.select("reactions adminReactions")` |

Both reads already happen once per message; adding one field adds bytes, not round trips.

### 10.3 The latent bug in `flushReactionBatch` that must be fixed BEFORE shipping

Today at [service.js:222-223](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L222-L223):
```js
const reactions = reactionBatch.get(messageId);
if (!reactions) continue;
```
A messageId dirty solely from admin deltas (no real reactions in this flush window) would be **silently dropped**. Fix:
```js
const reactions = reactionBatch.get(messageId);
const adminDeltas = adminReactionBatch.get(messageId);
if (!reactions && !adminDeltas) continue;
```

### 10.4 The real-user broadcast must also include `adminReactions` — server side

Today the `add_reaction` handler emits `{ messageId, reactions }` only. If clients are upgraded to spread `data.adminReactions` into state, an `add_reaction` broadcast would clobber their `adminReactions` to `undefined`.

Fix in both the real-user handler and the new admin handlers — always emit the combined view:

```js
// inside the existing add_reaction handler, after applyReactionService returns:
const adminSnapshot = readAdminSnapshot(messageId);  // returns {} if not loaded
io.to(roomId).emit("message_reaction_updated", {
  messageId,
  reactions,             // from applyReactionService
  adminReactions: adminSnapshot,
});
```

`applyReactionService` already does a first-access DB read on the message — extend its `.select()` to pull `adminReactions` and seed `adminReactionSnapshot` in the same call. Cost: zero extra DB round trips.

### 10.5 The real-user broadcast must also include `adminReactions` — client side defense

Even with the server fix, partial-rollout windows happen. Make the listener defensive — preserve `adminReactions` when the payload omits it:

```ts
newSocket.on("message_reaction_updated", (data) => {
  isReactionUpdateRef.current = true;
  setMessages((prev) =>
    prev.map((msg) =>
      msg._id === data.messageId
        ? {
            ...msg,
            reactions: data.reactions,
            // Only overwrite if server actually sent the field
            adminReactions: data.adminReactions ?? msg.adminReactions,
          }
        : msg,
    ),
  );
});
```

Belt + suspenders: server always sends, client preserves on omission. Either side alone is sufficient; both makes the rollout window safe.

### 10.6 Old messages with no `adminReactions` field

Mongoose `Map<Number>` with `default: {}` ensures **new writes** always have the field. Existing messages in Mongo without it: read paths see `adminReactions: undefined`. All render paths use `msg.adminReactions || {}` — handled.

Same goes for Redis sorted-set cached messages serialized before the schema change — they lack the field until the Lua script patches them. Defensive `|| {}` guards the client.

### 10.7 Picker and hover panel — anchor stability

- **Picker anchor**: the smiley `+` IconButton is part of the message row. Rows are append-only; the IconButton's DOM node stays stable while the picker is open. Safe.
- **Hover panel anchor**: a reaction pill can disappear if a real-user un-reacts the only real reaction AND admin count drops to 0 at the same instant. Guard:

  ```tsx
  useEffect(() => {
    if (!hoverPanel) return;
    const msg = messages.find((m) => m._id === hoverPanel.messageId);
    const realN = msg?.reactions?.[hoverPanel.emoji]?.length || 0;
    const adminN = msg?.adminReactions?.[hoverPanel.emoji] || 0;
    if (realN + adminN === 0) {
      isPopoverOpenRef.current = false;
      setHoverPanel(null);
    }
  }, [messages, hoverPanel]);
  ```

  Closes the panel cleanly if the anchored pill is about to unmount.

### 10.8 Existing client `emitReaction` optimistic update — preserve `adminReactions`

[chatBox.tsx:1187-1214](/Users/arshad/learning/football-next-score8o8/src/components/chatBox/chatBox.tsx#L1187-L1214) builds a fresh `reactions` object and returns `{ ...msg, reactions }`. The spread already preserves `adminReactions`. No change strictly needed — but worth verifying in implementation since `Object.entries(msg.reactions || {})` doesn't touch admin counts.

### 10.9 The Lua script

Today, `REACTION_SORTED_SET_SCRIPT` decodes the message and writes `decoded['reactions']`. Extending it to also write `decoded['adminReactions']` is purely additive on the cached JSON. Messages cached **before** the script change have no `adminReactions` key; messages cached **after** do. The client treats both with `|| {}`. No invalidation, no migration.

The script still runs in a single `EVAL` — atomicity unchanged, race window unchanged.

### 10.10 PM2 process restart

In-memory state lost (same as today for `reactionBatch`). On next admin reaction, snapshot reloads from canonical Mongo, which holds all `$inc`-merged increments from other processes. Any unflushed delta at the moment of restart is lost — same risk profile as today's real-user reactions, acceptable per the existing convention documented in `BATCH_FLUSH_CLUSTER_PLAN.md`.

---

## 11. PERFORMANCE GUARANTEES

| Vector | Baseline | After change | Impact |
|---|---|---|---|
| Mongo round trips per real-user reaction | 1 lazy read (first access) + 1 `updateOne` per flush + 1 canonical re-read per flush | Same — `adminReactions` co-fetched in the same `.select()` | 0 extra round trips |
| Mongo round trips per admin reaction | n/a | 1 lazy read (first access, **shared with real-user lazy-seed if either touched first**) + amortized into the same `updateOne` per flush | 0 extra round trips beyond the first-access seed |
| `updateOne` payload size | `$set`/`$unset` for reactions | Same + `$inc` for adminReactions (only if deltas exist) | Identical wire format, additive bytes |
| Lua `EVAL` calls | 1 per flush per messageId | Same — extended script writes both fields | 0 extra calls |
| Broadcast payload size | `~ users.length * 16B per emoji` JSON | + at most 7 emoji→Number entries (~70-100 bytes) | Negligible with socket.io compression |
| Admin rapid-click (e.g., 50 clicks in 2s) | n/a | 50 in-memory increments, 1 `$inc { 'adminReactions.👍': 50 }` per flush window | Same scaling as today's typing throttle |
| Client render cost per message | `Object.entries(reactions)` | `Object.entries(reactions)` + `Object.entries(adminReactions)` + dedupe | O(7) constant per message — bounded by `ALLOWED_REACTIONS.length` |
| Memory: in-memory batches | `reactionBatch` + `reactionRetries` + `dirtyMessageIds` per active message | + `adminReactionBatch` + `adminReactionSnapshot` per active message | One additional `Map<emoji, Number>` and one `Map<emoji, Number>` per message — bounded; same eviction lifecycle as `reactionBatch` |
| Socket auth check per admin reaction | n/a | `if (!socket.isAdmin)` boolean read | O(1) |

### Why nothing slows down the hot path

The **hot path** is real-user `add_reaction` events arriving from the score8o8 chat. The plan touches the hot path only in two ways:
1. The lazy-seed `.select()` gains one extra field — 1-2 bytes more on the wire from Mongo.
2. The broadcast payload gains the `adminReactions` field — at most ~100 bytes JSON, well under socket.io's compression threshold.

No extra Mongo writes, no extra Redis calls, no extra Lua evals, no extra broadcasts. The new feature **piggybacks on existing trips**.

### Admin-side hot path

The new hot path is the admin spam-clicking the picker. This is bounded by:
- Network — one socket emit per click (negligible)
- Server — one in-memory `Map.set` per click, accumulated into a single `$inc` per flush window
- Broadcast — one `message_reaction_updated` per click (could be 50/sec in worst case). Each is `O(emojis) = 7` JSON entries. Socket.io's room broadcast scales with room size, not click rate, so 1000 viewers in a room cost the same per broadcast.

**Optional throttle** if peak admin clicks ever exceed broadcast bandwidth: server-side debounce the broadcast (e.g., coalesce within 100ms windows) while still applying every in-memory increment. Not in v1 — defer until observed.

### What we explicitly do NOT do (and why)

- **No new Redis keys.** Admin reactions live inside the existing message JSON in the sorted set. No new key namespace, no new TTLs, no new memory growth in Redis.
- **No new Mongo indexes.** `adminReactions` is read only by `_id` (already indexed primary key).
- **No new socket rooms.** Admins are already joined to the chat rooms they admin via `admin_join_room`.
- **No optimistic update on admin side in v1.** Avoids state-divergence under multi-admin concurrency. Canonical broadcast round trip is ~50-100ms — fine.

---

## 12. ROLLOUT ORDER

1. **Backend first** — schema + service + socket handlers + Lua extension. Real-user reactions keep working since the field is additive. The two `.select()` extensions and the `flushReactionBatch` early-continue fix go in this PR.
2. **Verify with a manual `socket.emit` from a console** that `admin_add_reaction` increments and broadcasts `adminReactions`, and that real-user `add_reaction` now also broadcasts `adminReactions`.
3. **Score8o8 client** — additive render change with the defensive `?? msg.adminReactions` listener. Old clients still work (just see fewer reactions).
4. **Admin UI** — picker + hover panel.

Each step is independently deployable; the no-regression guarantees above mean nothing breaks if step N is shipped before step N+1.

---

# Implementation Notes — 2026-05-19

**Status:** Implemented end-to-end across `football-chat-backend`, `football-next-score8o8`, `football-admin`. TypeScript clean (`tsc --noEmit` exit 0) on both frontend projects. Node syntax clean on backend.

## What was implemented

Matches §1–§9 of the plan above. Concrete file outcomes:

### `football-chat-backend/modules/chat/messageModel.js`
- Added `adminReactions: { type: Map, of: Number, default: {} }` sibling to `reactions`.

### `football-chat-backend/modules/chat/service.js`
- Added `adminReactionBatch` and `adminReactionSnapshot` Maps (matching `reactionBatch` lifecycle).
- Extended `REACTION_SORTED_SET_SCRIPT` Lua to patch `decoded['adminReactions']` from `ARGV[3]` in the same atomic `ZREM`/`ZADD`.
- `updateReactionInSortedSet` now accepts and serializes `adminReactionsFromDb` as the 4th arg.
- Added `readAdminSnapshot(messageId)` — read-only serializer used by socket handlers.
- Added `serializeCombinedReactions(messageId)` — single shape for every broadcast (real-user OR admin).
- Refactored the lazy DB seed into `seedReactionStateIfNeeded(messageId)`. **One `.select("reactions adminReactions")` seeds both maps** — no extra round trips on the hot path. `applyReactionService` now uses this shared seeder.
- Added `applyAdminReactionService(messageId, emoji, delta)` with in-memory floor-at-zero and per-emoji delta accumulation.
- Extended `flushReactionBatch`:
  - Bug fix: the early-`continue` at the original [service.js:222-223](/Users/arshad/learning/football-chat-backend/modules/chat/service.js#L222-L223) now checks both `reactionBatch` and `adminReactionBatch`. Admin-only flush cycles used to be silently skipped.
  - Combined `$set`/`$unset`/`$inc` into the same `updateOne` per dirty message.
  - Canonical re-read after success now also pulls `adminReactions` and refreshes the snapshot from Mongo (handles cross-instance `$inc` merges).
  - Calls `updateReactionInSortedSet` with both fields.
- Exports added: `applyAdminReactionService`, `readAdminSnapshot`.

### `football-chat-backend/socket/socketHandler.js`
- Imported `applyAdminReactionService`, `readAdminSnapshot`.
- Existing `add_reaction` broadcast extended to include `adminReactions: readAdminSnapshot(messageId)` — prevents partial-rollout clients from clobbering admin counts in state.
- New `admin_add_reaction` and `admin_remove_reaction` handlers, both gated on `socket.isAdmin` (same pattern as `admin_room_message`, `admin_join_room`, etc.). Both validate against the existing `ALLOWED_REACTIONS` const.

### `football-next-score8o8/src/components/chatBox/chatBox.tsx`
- Extended `MessageNew` with `adminReactions?: Record<string, number>`.
- `room_message` render uses combined-emoji-order union of real + admin; total count = `users.length + (adminReactions[emoji] || 0)`; pill shows count only when total > 1. Highlight (`isMine`) logic uses real-user array only — unchanged semantics.
- `reactionCount` (used for margin-bottom layout) computed from combined order.
- `message_reaction_updated` listener uses `data.adminReactions ?? msg.adminReactions` (defensive preserve).
- Optimistic `emitReaction` explicitly preserves `msg.adminReactions` in the spread.

### `football-admin/src/sections/matches/chat-table-rows.tsx`
- Extended `MessageNew` and added `ALLOWED_REACTIONS` constant.
- Imported `Popover`.
- New state: `pickerAnchor`, `hoverPanel`, `hoverCloseTimerRef`.
- New emit helpers: `emitAdminAdd`, `emitAdminRemove`.
- New panel handlers: `openPicker`/`closePicker`, `openHoverPanel`/`scheduleHoverClose`/`cancelHoverClose` (150 ms hover-bridge).
- Auto-close-on-empty effect: closes hover panel if its anchored pill's `realN + adminN` drops to 0 mid-hover.
- Cleanup effect clears `hoverCloseTimerRef` on unmount.
- Defensive `message_reaction_updated` listener (same `??` pattern).
- Pill row now renders the combined emoji set with hover handlers, followed by the smiley `+` IconButton that opens the picker.
- Two `Popover`s mounted at the top level of the return:
  - **Picker** — emoji grid, anchored to the `+` button.
  - **Hover panel** — `-` / emoji / `+`, anchored to the hovered pill. `Popover` wrapper `pointerEvents: 'none'`, `PaperProps.sx: { pointerEvents: 'auto' }` so the user can move the mouse from pill into panel without losing hover. `-` button uses `disabled={adminCount === 0}` and is wrapped in a `<span>` so the Tooltip still works while disabled.
- Both Popovers set `isPopoverOpenRef.current = true` while open — reuses the **existing scroll-lock primitive** (the `useEffect` that runs `el.scrollTo` at [chat-table-rows.tsx:351-365](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx#L351-L365) already bails out when this ref is true). No new lock state.

## Deviation from the plan

### Picker now closes on emoji click (changed during testing)

The plan originally specified that the admin picker would **stay open** after each emoji click so the admin could spam-click the same emoji from the picker itself. During testing this was changed: the picker now closes after one click, and the admin performs follow-up increments via the hover panel's `+` button on the resulting pill.

**Reason:** The hover panel already supports rapid `+`/`-` with the count visible in real time, and a sticky picker required the admin to mentally track which emoji they just clicked. Closing the picker after one click is the standard reaction-picker UX (Slack, Discord, Linear), and the hover panel covers the spam-click use case more ergonomically.

The picker's `onClick` now calls `closePicker()` after `emitAdminAdd(...)`:

```tsx
onClick={() => {
  if (pickerAnchor) emitAdminAdd(emoji, pickerAnchor.messageId);
  closePicker();
}}
```

No other UX deviations from the plan.

## Verification done

- `node -c` on the three backend files (syntax clean).
- `npx tsc --noEmit -p tsconfig.json` on `football-admin` (exit 0).
- `npx tsc --noEmit -p tsconfig.json` on `football-next-score8o8` (exit 0).
- Manual code review of every edit confirmed against the no-regression guarantees in §10.

---

# Performance Analysis — Before / After

**Date:** 2026-05-19  
**Baseline:** Real-user reactions only (existing behavior before this feature).  
**Scope:** Hot path (per-message reaction throughput) and admin spam-click bursts.  
**Workload assumption:** ~5% of messages get reacted to → at 300 msg/s cluster-wide (post-PERF_REPORT.md state), ~15 reactions/s cluster-wide = ~3 reactions/s per instance.

---

## Hot path — real-user `add_reaction` event

The dominant existing path. Plan target: **zero added round trips.**

### Per-event work

| Phase | Before | After | Diff |
|-------|--------|-------|------|
| First-access lazy seed (Mongo `findById`) | `select("reactions")` → ~80 B doc | `select("reactions adminReactions")` → ~120 B doc | +1 field name on wire, ~40 B extra payload, **0 extra round trips** |
| In-memory toggle | `reactionBatch.get(msgId)` + `Set.delete`/`Set.add` | Identical | — |
| Broadcast payload | `{ messageId, reactions }` ~80–200 B JSON | `{ messageId, reactions, adminReactions }` ~100–250 B JSON | +20–50 B per broadcast, **gzip ~negligible** |
| Mongo flush (per dirty msg) | `updateOne` with `$set`/`$unset` | Same call, optionally adds `$inc` if admin deltas exist | Same call, 0 extra round trips |
| Canonical re-read (per successful flush) | `select("reactions roomId")` | `select("reactions adminReactions roomId")` | +1 field name on wire, **0 extra round trips** |
| Redis sorted-set patch (per successful flush) | 1 `EVAL` writing 1 field | 1 `EVAL` writing 2 fields | Same `EVAL` count, +20–100 B in the script's JSON arg, **0 extra round trips** |

### Math at 3 reactions/s per instance (15 cluster-wide)

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| Mongo `findById` round trips (cold cache) | 3/s | 3/s | — |
| Mongo `findById` payload bytes/s | ~240 B | ~360 B | +120 B/s per instance (**negligible**) |
| Mongo `updateOne` calls/s (per flush window) | depends on flush mode | identical | — |
| Redis `EVAL` calls/s | depends on flush mode | identical | — |
| Broadcast payload bytes/s (1,200 viewers/room average) | ~144 KB/s per instance | ~180 KB/s per instance | +36 KB/s per instance pre-gzip; **~3 KB/s after socket.io permessage-deflate** |
| Event-loop CPU per event | ~0.1 ms | ~0.1 ms | — |

**Net: zero added round trips, ~3 KB/s extra wire bytes per instance after compression.**

---

## New path — `admin_add_reaction` / `admin_remove_reaction`

### Per-click cost

| Step | Cost |
|------|------|
| Auth check | `if (!socket.isAdmin) return;` — O(1) property read |
| Emoji validation | `ALLOWED_REACTIONS.includes(emoji)` — O(7) array scan |
| Lazy seed (first click on a message only) | 1 Mongo `findById` — same as real-user path, **shared cache** |
| In-memory increment | `Map.set` × 2 (snapshot + delta) — O(1) |
| Floor-at-zero check (decrement only) | O(1) |
| Broadcast | 1 `io.to(roomId).emit` — same fan-out cost as real-user |

### Admin spam-click burst

Realistic worst case: 1 admin clicking `+` 5×/s on the same message for 10 s (50 clicks total).

| Phase | Cost |
|-------|------|
| Lazy seed | 1 Mongo round trip (first click), cached for all 49 follow-ups |
| In-memory increments | 50 `Map.set` calls (~5 µs total) |
| Mongo writes during 10 s window | **1** `$inc { 'adminReactions.👍': 50 }` per flush — coalesced. At 1 s flush window: 10 `updateOne`s, each `$inc` by 5. At 5 s flush window (peak mode): 2 `updateOne`s, each `$inc` by 25 |
| Redis `EVAL` calls | Same count as `updateOne`s |
| Broadcasts | 50 — one per click, ~250 B each → ~12.5 KB total over 10 s |

**Key point:** Mongo write count scales with **flush window**, not click rate. 50 admin clicks in 10 s cost the same Mongo writes as 5 clicks in 10 s (1 per flush window).

### Math at multi-admin worst case (5 admins each clicking 5×/s for 10 s = 250 clicks)

| Metric | Cost |
|--------|------|
| Total Mongo writes (peak mode, 5 s flush) | 2 `updateOne`s per message × 5 admins potentially on different messages = up to 10 `updateOne`s total in 10 s |
| Total Redis `EVAL`s | Same as Mongo writes |
| Total broadcasts | 250 (one per click) |
| Total event-loop CPU per instance | ~250 × 0.05 ms = ~12.5 ms per instance over 10 s (~0.13% of one core) |

---

## Memory impact

| Structure | Per-message cost | Bound |
|-----------|------------------|-------|
| `adminReactionBatch` Map entry | `Map<emoji, Number>` — up to 7 entries × ~40 B = ~280 B | Only for messages with **pending** admin deltas; cleared post-flush |
| `adminReactionSnapshot` Map entry | Same shape — ~280 B | Only for messages **touched** since process start; cleared post-flush when canonical snapshot is empty AND batch is empty |
| Schema `adminReactions` field on `Message` | Mongo `Map<Number>` — up to 7 entries × ~12 B = ~84 B per doc | Only on messages with at least one admin reaction; absent otherwise |

At 1,000 active messages with admin reactions: ~560 KB per instance. Tiny compared to the ~50 MB socket connection budget at 30K users (per PERF_REPORT.md).

---

## Network impact

| Direction | Bytes added per event |
|-----------|----------------------|
| Client → server (admin click) | 1 socket emit, ~80 B payload |
| Server → room broadcast (per reaction) | +20–50 B JSON (`adminReactions` field) |
| Redis `EVAL` script args (per flush) | +20–100 B JSON |
| Mongo wire (per `updateOne`) | +20–80 B (the `$inc` clause) |
| Mongo wire (per `findById`) | +20–80 B (the extra field in select projection + response) |

All are **single-digit-percentage** additions to existing payloads.

---

## Consolidated Before / After

### Per-instance load at 3 real-user reactions/s + occasional admin bursts

| Source | Before | After | Change |
|--------|--------|-------|--------|
| Mongo round trips for reactions | 3 lazy-seeds/s + flush calls | Same — admin reactions piggyback | **0 extra** |
| Redis `EVAL`s for reactions | 1 per flush per dirty msg | Same — extended script | **0 extra** |
| Broadcasts/s | 3/s | 3/s + N admin clicks/s | +N (admins click manually) |
| Hot-path CPU per event | ~0.1 ms | ~0.1 ms | — |
| Wire bytes/s per instance | ~144 KB/s | ~147 KB/s (pre-compression) | +2% |

### Admin spam-click rate vs Mongo write rate

| Admin clicks/s | Mongo writes/s (normal mode, 1 s flush) | Mongo writes/s (peak mode, 5 s flush) |
|----------------|----------------------------------------|--------------------------------------|
| 1 | 1 | 0.2 |
| 5 | 1 | 0.2 |
| 25 | 1 | 0.2 |
| 100 | 1 | 0.2 |

Mongo write rate is **decoupled from click rate** — bounded by flush window. This is the same write-batching pattern the rest of the system uses.

---

## What is NOT changing (end-user behaviour preserved)

- Real-user `add_reaction` toggle/switch semantics — unchanged.
- Reaction pill highlight ("you reacted with X") logic — unchanged (admin reactions never highlight).
- Reactions written to Mongo via per-emoji `$set`/`$unset` for real users — unchanged (admin reactions use `$inc` in the same `updateOne`, not instead of).
- Redis sorted-set message cache lifecycle — unchanged (Lua script extension is additive on the cached JSON; old cached messages lack the field and clients render `|| {}`).
- History endpoints (`getRecentMessagesWithCache`, `retrieveRoomMessagesService`, pinned-message fetch) — unchanged, return the new field automatically via `.lean()` without projection.
- PM2 multi-instance flush retry semantics — unchanged (admin retries piggyback on the same `dirtyMessageIds` + `MAX_REACTION_RETRIES` path).
- Auto-scroll lock convention — unchanged (admin Popovers reuse `isPopoverOpenRef`, the existing primitive).

---

## Files Changed

| File | Change summary |
|------|----------------|
| `football-chat-backend/modules/chat/messageModel.js` | + `adminReactions: Map<Number>` |
| `football-chat-backend/modules/chat/service.js` | + admin batch/snapshot Maps, `applyAdminReactionService`, `readAdminSnapshot`, `serializeCombinedReactions`, `seedReactionStateIfNeeded`. Extended Lua script + `updateReactionInSortedSet` + `flushReactionBatch` (incl. early-continue bug fix). Two `.select()` projections widened. |
| `football-chat-backend/socket/socketHandler.js` | + `admin_add_reaction`, `admin_remove_reaction` handlers; existing `add_reaction` broadcast now includes `adminReactions` |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | `MessageNew` extended; combined-count pill render; defensive listener; optimistic update preserves `adminReactions` |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | `MessageNew` extended; combined-count pill render; smiley `+` button; picker `Popover` (closes on click); hover panel `Popover` with `-`/emoji/`+` and disabled-minus-at-zero; auto-close-on-empty effect; defensive listener |

---

# Update — 2026-05-20: Client-Side Debouncing of Admin Reactions

**Status:** Implemented. Backend syntax clean, admin TypeScript clean.

## Why

In the initial implementation every admin click on the picker emoji / hover-panel `+` / `-` fired one `socket.emit` immediately, which the server translated into one in-memory increment **and one `message_reaction_updated` broadcast to every viewer in the room**. With 10,000 viewers per room and 10 clicks/sec, that's **100,000 downstream emits per second** for a single admin's spam. The Mongo writes were already coalesced via the flush window (§11), but the broadcast amplification was not.

## What changed

### Client side ([`football-admin/src/sections/matches/chat-table-rows.tsx`](/Users/arshad/learning/football-admin/src/sections/matches/chat-table-rows.tsx))

- **Per-`(messageId, emoji)` accumulator** — `adminDeltasRef: Map<"messageId|emoji", signed_int>` tracks net pending delta per pill.
- **`lodash/debounce`** (300 ms, created once via `useMemo`) wraps `flushAdminReactions`. Every click resets the timer; the flush only fires after the burst stops.
- **On flush**, the accumulator is walked once: for each non-zero key, **one** `admin_add_reaction` (if delta > 0) or `admin_remove_reaction` (if delta < 0) is emitted with `{ roomId, messageId, emoji, delta: |n| }`.
- **Optimistic local update** — `setMessages` bumps `msg.adminReactions[emoji]` synchronously on every click (clamped at 0). The admin sees the count tick immediately while the server emit is pending. Server echo overwrites this with the canonical value when it arrives.
- **Stable refs** for `socket`, `isAuthenticated`, `roomId` — the debounced function reads through refs so its identity stays stable across re-renders, otherwise React would re-create the debounce and cancel pending bursts.
- **Unmount cleanup** calls `flushAdminReactions.flush()` so any in-flight delta still hits the server before the component disappears.
- **No cap.** A reconsidered decision — `socket.isAdmin` is already the trust boundary, Mongo `$inc` handles any 64-bit int, and a cap doesn't prevent sustained spam (just shifts it to multiple bursts). The cap added friction without real safety.

### Backend side ([`football-chat-backend/socket/socketHandler.js`](/Users/arshad/learning/football-chat-backend/socket/socketHandler.js))

Three-line change on each of `admin_add_reaction` and `admin_remove_reaction`:

```js
const { roomId, messageId, emoji, delta } = data || {};
// ...validation...
const n = Math.max(parseInt(delta, 10) || 1, 1);
const result = await applyAdminReactionService(messageId, emoji, +n /* or -n */);
```

- Reads `delta` from the payload; defaults to `1` if omitted (so any pre-debounce-rollout client still works).
- Floor of 1 prevents zero or negative values from inverting the operation.
- No upper cap — the admin is already trusted.
- `applyAdminReactionService` already accepted arbitrary signed integers; no service-layer change.

## Performance — before / after debounce

### Worst-case admin spam: 50 clicks in 2 s on one (`messageId`, `emoji`)

| Vector | Before debounce | After debounce | Δ |
|--------|----------------|----------------|---|
| Socket emits (admin → server) | 50 | **1** | −98% |
| `applyAdminReactionService` calls | 50 | **1** | −98% |
| Server broadcasts (`message_reaction_updated`) | 50 | **1** | −98% |
| Total downstream emits at 10K viewers | 500,000 | **10,000** | −98% |
| Mongo `$inc` ops per flush window (peak mode, 5 s flush) | 1 (already coalesced) | 1 | — |
| Optimistic count visible to admin | Lags by ~50 ms × 50 echoes | **Instant on every click** | — |

### Realistic burst: 5 admins each clicking 5×/s for 10 s = 250 total clicks

| Vector | Before | After (each admin debounces individually) | Δ |
|--------|--------|------------------------------------------|---|
| Total admin emits | 250 | ~10 (one per ~300 ms quiet pause per admin) | −96% |
| Total `message_reaction_updated` broadcasts | 250 | ~10 | −96% |
| Viewer client re-renders at 10K viewers | 2.5 M | ~100K | −96% |
| Mongo `$inc` ops over the 10 s window | 2 per messageId (coalesced) | Same | — |

The Mongo write count was already decoupled from click rate (§11). Debouncing closes the gap by also decoupling the **broadcast** count from click rate.

### What is NOT changing

- Optimistic admin UI reconciles with server echoes — same shape, same listener.
- Backwards compat: server still accepts old-style emits without `delta` (defaults to 1), so a partially-rolled-out admin keeps working.
- All §10 no-regression guarantees still hold (no extra Mongo round trips, no extra Redis EVALs, scroll-lock conventions unchanged).
- Anonymous and real-user `add_reaction` events are **not** debounced — per-user one-per-message toggle/switch semantics are unchanged. Only the admin-multi path debounces, because only it can produce rapid same-pill repeats.

## Files Changed (debounce update)

| File | Change summary |
|------|----------------|
| `football-admin/src/sections/matches/chat-table-rows.tsx` | + `lodash/debounce` import; + `adminDeltasRef` accumulator; + `flushAdminReactions` debounced flush (300 ms); + `applyOptimisticAdminDelta` for instant local UI; refactored `emitAdminAdd`/`emitAdminRemove` into a shared `queueAdminReaction`; unmount cleanup |
| `football-chat-backend/socket/socketHandler.js` | `admin_add_reaction` and `admin_remove_reaction` now read `data.delta` (default 1, floor 1); no upper cap |
