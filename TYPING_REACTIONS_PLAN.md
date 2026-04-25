# Typing Indicator & Message Reactions — Implementation Plan

## Overview

Two features across three projects:
- `football-chat-backend` — socket events + data layer
- `football-next-score8o8` — client UI + emit/receive
- `football-admin` — read-only display of both features

---

## 1. TYPING INDICATOR

### How it works
- Client emits `typing_start` on keypress (debounced)
- Client emits `typing_stop` on send or after 1.5s idle
- Backend maintains a per-room in-memory `Map<roomId, Map<socketId, { username, timer }>>`
- On each change, backend broadcasts `user_typing` with the current names array to the whole room
- Auto-clears a user after 5s with no `typing_start` (handles tab switch / disconnect without stop event)
- Admin receives `user_typing` broadcast but never emits typing events

### Display logic (client + admin)
| Typing users | Display |
|---|---|
| 0 | nothing |
| 1 | `guest2 is typing...` |
| 2 | `guest2 and guest3 are typing...` |
| 3+ | `guest2, guest3 and 2 others are typing...` |

Animated `...` using CSS keyframe opacity pulse.

### Storage
- **In-memory only** — typing state is ephemeral (1-2s lifespan)
- Socket.io Redis adapter already broadcasts across all PM2 processes
- No Redis, no MongoDB changes needed

---

## 2. MESSAGE REACTIONS

### How it works
- Every message has a always-visible 😊 `IconButton` on the right side
- Clicking it opens a small `Popover` with 5 emoji options: 👍 ❤️ 😂 😮 😢
- While the popover is open, **auto-scroll is locked** (via `isPopoverOpenRef`)
- Clicking an emoji emits `add_reaction` to the backend
- Toggle: clicking your active emoji again removes it
- Switch: clicking a different emoji replaces your previous one (one reaction per user per message)
- Reaction counts shown as pills below message content: `👍 3  ❤️ 1`
- Admin sees reaction pills read-only — no 😊 button, no interaction

### Socket events
| Event | Direction | Payload |
|---|---|---|
| `add_reaction` | client → server | `{ roomId, messageId, emoji }` |
| `message_reaction_updated` | server → room | `{ messageId, reactions: { "👍": ["u1","u3"], "❤️": ["u2"] } }` |

### Storage — In-memory batch + MongoDB flush (same pattern as messages)

**In-memory batch** (per process, in `socketHandler.js` or a new `reactionManager.js`):
```js
// Map<messageId, { "👍": Set<username>, "❤️": Set<username> }>
const reactionBatch = new Map();
```

**On `add_reaction` event:**
1. Get or create entry in `reactionBatch` for `messageId`
2. Apply toggle/switch logic on the in-memory Sets
3. Broadcast `message_reaction_updated` immediately to room
4. Mark `messageId` as dirty (needs flush)

**Flush interval** (same cadence as message batch — 1-5s based on perf mode):
```js
// For each dirty messageId:
// Message.updateOne({ _id: messageId }, { $set: { reactions: serialized } })
```

**On message history load** (`fetchChatMessages`):
- Messages from MongoDB already have `reactions` field
- No extra lookup needed

### MongoDB — Message model change
Add `reactions` field to `messageModel.js`:
```js
reactions: {
  type: Map,
  of: [String],   // emoji -> array of usernames
  default: {},
}
```

---

## 3. IMPLEMENTATION STEPS

### Step 1 — Backend (`football-chat-backend`)

#### 1a. Message model
- Add `reactions` field to `messageModel.js`

#### 1b. Typing handler in `socketHandler.js`
- Add `typingUsers` Map at module level: `Map<roomId, Map<socketId, { username, timer }>>`
- Listen to `typing_start`:
  - Add/reset user entry with 5s auto-clear timer
  - Broadcast `user_typing` with current names array to room (exclude sender)
- Listen to `typing_stop`:
  - Remove user entry, clear timer
  - Broadcast updated `user_typing` to room
- On `disconnect`:
  - Remove user from all typing maps, broadcast updates

#### 1c. Reaction handler in `socketHandler.js` (or new `reactionManager.js`)
- Add `reactionBatch` Map and `dirtyMessageIds` Set at module level
- Listen to `add_reaction`:
  - Validate: `roomId`, `messageId`, `emoji` present; emoji in allowed list
  - Check banned users (same as message handler)
  - Apply toggle/switch logic on in-memory batch
  - Broadcast `message_reaction_updated` to room with full reactions object
  - Mark messageId as dirty
- Add flush interval (tied to perf mode cadence):
  - For each dirty messageId, run `Message.updateOne` with serialized reactions
  - Clear dirty set after flush

#### 1d. History endpoint
- `fetchChatMessages` — no change needed, `reactions` comes from MongoDB automatically once model is updated

---

### Step 2 — Client (`football-next-score8o8` — `chatBox.tsx`)

#### Typing
- Add `typingUsers` state: `string[]`
- In `ChatInput`, on every keypress emit `typing_start` to socket (pass socket down or use a ref)
- Debounce: after 1.5s of no keypress emit `typing_stop`
- On message send: emit `typing_stop` immediately
- Listen to `user_typing` → set `typingUsers` state
- On disconnect/unmount: emit `typing_stop`
- Render typing indicator between message list and input box:
  ```
  guest2 is typing...   (animated dots)
  ```

#### Reactions
- Add `isPopoverOpenRef = useRef(false)` — plug into existing smart scroll `useEffect` (already has the check ready from admin pattern)
- Add `reactionAnchor` state: `{ el: HTMLElement, messageId: string } | null`
- Add `openReactionPicker(el, messageId)` and `closeReactionPicker()` handlers
- On `add_reaction` emit: `{ roomId, messageId, emoji }`
- Listen to `message_reaction_updated` → update that message's reactions in state in-place
- On message history load: reactions come from MongoDB, already on message objects
- In message render (`room_message` type):
  - Add 😊 `IconButton` always visible, right side of message header
  - Add `Popover` with 5 emoji `IconButton`s: 👍 ❤️ 😂 😮 😢
  - Add reaction pills below message content if reactions exist
  - Highlight the pill of the emoji the current user has reacted with

---

### Step 3 — Admin (`football-admin` — `chat-table-rows.tsx`)

#### Typing (read-only)
- Add `typingUsers` state: `string[]`
- Listen to `user_typing` → set state
- Render typing indicator same as client (display only)

#### Reactions (read-only)
- Listen to `message_reaction_updated` → update message reactions in state in-place
- On message history load: reactions come from MongoDB automatically
- In `room_message` render: add reaction pills below message content
- No 😊 button, no Popover, no emit

---

## 4. NEW SOCKET EVENTS SUMMARY

| Event | From | To | Payload |
|---|---|---|---|
| `typing_start` | client | server | `{ roomId, username }` |
| `typing_stop` | client | server | `{ roomId, username }` |
| `user_typing` | server | room | `{ names: string[] }` |
| `add_reaction` | client | server | `{ roomId, messageId, emoji }` |
| `message_reaction_updated` | server | room | `{ messageId, reactions: { emoji: string[] } }` |

---

## 5. FILES TO CHANGE

| File | Changes |
|---|---|
| `football-chat-backend/modules/chat/messageModel.js` | Add `reactions` field |
| `football-chat-backend/socket/socketHandler.js` | Typing handlers + reaction handlers + flush interval |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Typing emit/display + reaction UI + scroll lock |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | Typing display + reaction pills read-only |

---

## 6. ALLOWED EMOJIS

```js
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢'];
```

Validated on the backend — any other emoji is rejected.
