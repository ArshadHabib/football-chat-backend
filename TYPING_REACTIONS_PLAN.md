# Typing Indicator & Message Reactions — Implementation

## Overview

Two features across three projects:
- `football-chat-backend` — socket events + data layer
- `football-next-score8o8` — client UI + emit/receive
- `football-admin` — read-only display of both features

---

## 1. TYPING INDICATOR

### How it works
- Client emits `typing_start` on first `onChange` (not on keypress, not debounced). Sends a heartbeat every 3s to reset the server's 5s auto-clear timer.
- Client emits `typing_stop` on send or after 1.5s idle (`setTimeout 1500ms` reset on every keystroke)
- Backend maintains a per-room in-memory `Map<roomId, Map<socketId, { username, timer }>>`
- Backend broadcasts `user_typing` as a **single-user event** `{ username, isTyping: boolean }` — NOT a names array
- Each client maintains its own `typingUsers: string[]` array by adding/removing on each event
- Auto-clears a user after 5s with no `typing_start` (handles tab switch / disconnect without stop event)
- On disconnect, server clears all typing entries for that socket across all rooms
- 5-minute background sweep removes entries for abandoned rooms with no connected sockets
- Admin receives `user_typing` broadcast but never emits typing events

### Display logic (client + admin)
| Typing users | Display |
|---|---|
| 0 | nothing |
| 1 | `guest2 is typing...` |
| 2 | `guest2 and guest3 are typing...` |
| 3+ | `guest2, guest3 and N more are typing...` where N = `names.length - 2` |

Animated 3-dot bounce using CSS keyframe (`translateY` + opacity).

### Typing indicator UI
- **Client**: memoized `TypingIndicator` component, `position: absolute, bottom: 0, left: 0, right: 0` inside the `flex:1 position:relative` messages box. Opacity fade (0.2s). Theme-aware gradient: dark `rgba(0,0,0,0.55)`, light `rgba(255,255,255,1)`. `pointerEvents: none, zIndex: 2`. No layout shift.
- **Admin**: `position: absolute, top: -22, left: 16` inside the input wrapper `<Box sx={{ px: 2, position: 'relative' }}>`. Floats into the Paper's existing bottom padding. No gradient. Opacity fade (0.2s). No layout shift.

### Storage
- **In-memory only** — typing state is ephemeral
- Socket.io Redis adapter broadcasts across all PM2 processes
- No Redis, no MongoDB

---

## 2. MESSAGE REACTIONS

### How it works
- Every message has a `+` `IconButton` to open a reaction picker
- Clicking it opens a `Popover` with 7 emoji options: 👍 👎 ❤️ 😂 😮 😢 😡
- While the popover is open, **auto-scroll is locked** (via `isPopoverOpenRef`)
- Clicking an emoji emits `add_reaction` to the backend
- **Optimistic update**: client updates `messages` state immediately before emitting — no wait for server echo
- Toggle: clicking your active emoji again removes it
- Switch: clicking a different emoji replaces your previous one (one reaction per user per message)
- Reaction pills shown below message content: emoji always shown, count shown only when `users.length > 1` — e.g. `👍` (1 user) vs `👍 3` (3 users)
- Highlighted (`primary.main`) if the current user reacted with that emoji
- Typing only emitted for registered users — anonymous users (no `userName`) do not emit `typing_start`/`typing_stop`
- Admin sees reaction pills read-only — no picker button, no interaction

### Socket events
| Event | Direction | Payload |
|---|---|---|
| `typing_start` | client → server | `{ roomId, username }` |
| `typing_stop` | client → server | `{ roomId }` |
| `user_typing` | server → room | `{ username, isTyping: boolean }` |
| `add_reaction` | client → server | `{ roomId, messageId, emoji, username }` |
| `message_reaction_updated` | server → room | `{ messageId, reactions: { emoji: string[] } }` |

### Storage — In-memory batch + MongoDB flush

**In-memory batch** (in `modules/chat/service.js`):
```js
const reactionBatch = new Map(); // Map<messageId, Map<emoji, Set<username>>>
const dirtyMessageIds = new Set();
const reactionRetries = new Map(); // retry counter per messageId
const MAX_REACTION_RETRIES = 10;
```

**On `add_reaction` event:**
1. Load message reactions from DB into batch on first access for a `messageId`
2. Apply toggle/switch logic on in-memory Sets
3. Broadcast `message_reaction_updated` immediately to room
4. Mark `messageId` as dirty

**Flush interval** (fixed at startup — value taken from perf mode at boot time: 1s normal / 3s peak / 5s extreme):
```js
// Per-emoji $set/$unset — NOT whole-object overwrite
// Avoids cross-instance conflicts when different PM2 processes flush different emojis
MessageModel.updateOne({ _id: messageId }, {
  $set:   { "reactions.👍": ["u1", "u2"] },   // non-empty Sets
  $unset: { "reactions.😢": "" }               // empty Sets (removed)
})
```

**Retry logic:** if `matchedCount === 0` (message not in DB yet — still in write batch), re-adds to dirty set and retries up to 10 cycles, then discards.

**On message history load:** `reactions` field comes from MongoDB automatically — no extra lookup needed.

### MongoDB — Message model
```js
reactions: {
  type: Map,
  of: [String],   // emoji -> array of usernames
  default: {},
}
```

---

## 3. ALLOWED EMOJIS

```js
const ALLOWED_REACTIONS = ["👍", "👎", "❤️", "😂", "😮", "😢", "😡"];
```

Validated on the backend — any other emoji is rejected silently. Banned users also rejected.

---

## 4. FILES CHANGED

| File | Changes |
|---|---|
| `football-chat-backend/modules/chat/messageModel.js` | Added `reactions` field |
| `football-chat-backend/modules/chat/service.js` | Reaction batch, flush, retry logic |
| `football-chat-backend/socket/socketHandler.js` | Typing handlers + reaction handler |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Typing emit/display + reaction UI + optimistic update + scroll lock |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | Typing display + reaction pills read-only |
