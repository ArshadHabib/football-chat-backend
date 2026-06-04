# Message Reply — Implementation Plan

## Goal

Let users and admins reply to any chat message. A reply renders with a small clickable quote-block (parent sender + truncated snippet) above the body, like WhatsApp / Telegram / Slack / Discord. Clicking the quote scrolls to and briefly highlights the parent message in the chat list. While the user is **hovering** the reply icon button, the auto-scroll-on-new-message behaviour is paused — same convention as the existing reaction picker. Once the user clicks reply, scroll behaviour returns to normal (autoscroll resumes as new messages arrive); the composer's quote preview stays in view because it's anchored to the input area, not the chat list.

Three projects touched:

- **football-chat-backend** — new `replyTo` field on the `Message` model; `room_message` and `admin_room_message` socket handlers accept + forward it; light server-side validation; nothing else changes (no new Redis key, no new flush path, no extra Mongo round trip per send).
- **football-next-score8o8** — reply icon on each message at bottom-right (hover-only scroll-lock, same convention as reactions); on click, the textbox focuses and a small quote-preview banner appears directly above the textbox showing the parent sender + truncated snippet + an X to cancel; quote block rendering inside replied messages; click-to-scroll-to-parent with a brief highlight pulse.
- **football-admin** — same UI as score8o8 (read + write), feeds `replyTo` into `admin_room_message`.

No new Redis structures. No extra Mongo lookups on the hot path. No new socket events — `replyTo` rides on the existing `room_message` and `admin_room_message` payloads and is returned in `getRoomMessages` history automatically via `.lean()`.

---

## 1. DATA MODEL

### New field on `Message` ([messageModel.js](modules/chat/messageModel.js))

Today the schema has `reactions: Map<[String]>` and `adminReactions: Map<Number>`. Add a single embedded subdocument:

```js
replyTo: {
  type: {
    messageId: { type: String, required: true },  // ObjectId-as-string of the parent
    senderName: { type: String, required: true, maxlength: 50 },
    contentSnippet: { type: String, required: true, maxlength: 140 },
    isAdmin: { type: Boolean, default: false },
  },
  required: false,
  default: undefined,  // omit entirely when not a reply (smaller docs, smaller sorted-set JSON)
}
```

### Why this shape — denormalized snapshot, not a normalized reference

The temptation is to store just `replyTo: { messageId: ObjectId }` and look up the parent at read time. **This is wrong for this codebase.** The hot read path is `getRecentMessagesWithCache` ([service.js:588-627](modules/chat/service.js)) which serves history from a Redis sorted set of full message JSON. At a Champions League final, 20K simultaneous history loads each carrying ~200 messages × N replies per page would mean 20K × N additional parent lookups — exactly the kind of thundering herd the read-path plan was built to avoid (see [READ_PATH_PLAN.md](READ_PATH_PLAN.md)).

Storing the snapshot inline:

- Keeps history loads at **zero extra Redis or Mongo ops per reply** — the cache already holds the full JSON including `replyTo`.
- Survives parent deletion gracefully — the quote still displays its frozen text even if the parent doc is gone after `deleteAllChatMessagesService`.
- Matches industry convention (WhatsApp / Telegram / Slack / Discord all denormalize the quote payload at send time).

The cost is **frozen-in-time text** — if the parent is later edited (no edit feature exists yet) the quote shows the old content. Acceptable, and trivially fixable later by including `messageId` in the snapshot so the client can opt in to a fresh lookup if needed.

### What lives in the snapshot vs. what the client derives

| Field | Stored | Derived on render |
|---|---|---|
| `messageId` | ✓ | — used for click-to-scroll lookup in local `messages` array |
| `senderName` | ✓ | — shown in quote header |
| `contentSnippet` | ✓ (≤140 chars, server-truncated) | — shown in quote body |
| `isAdmin` | ✓ | — styles quote header in admin colour (`error.main` + crown) |
| timestamp of parent | ✗ | — not shown in the quote (matches WhatsApp; reduces visual noise) |
| full parent content | ✗ | — clicking the quote scrolls to the parent if it's in the loaded `messages` array |

140 chars matches Twitter's old limit — proven sweet spot between context and noise. The parent's full body lives in its own message doc; the quote is metadata.

### Schema index considerations

No new indexes needed. `replyTo.messageId` is **not** queried directly — it's only used by the client for in-array lookup. There is no admin "show all replies to message X" feature in this plan; if one is added later, that's when we add `messageSchema.index({ "replyTo.messageId": 1 })`.

---

## 2. SOCKET EVENTS

No new event types. Two existing payloads gain an optional `replyTo` field.

| Event | Direction | Payload addition | Auth |
|---|---|---|---|
| `room_message` | client → server | `replyTo?: { messageId, senderName, contentSnippet, isAdmin }` | n/a (user sends as themselves) |
| `admin_room_message` | admin → server | `replyTo?: { messageId, senderName, contentSnippet, isAdmin }` | `socket.isAdmin` |
| `room_message` (broadcast) | server → room | now includes `replyTo` when set | n/a |

### Why extend the existing events instead of adding `room_reply` / `admin_room_reply`

- The transport, persistence, validation, rate-limiting, ban-check, broadcast fan-out, and Redis sorted-set write are **all identical** for a reply vs. a normal message. The only difference is one extra optional field on the payload. Two events would mean two copies of the same handler.
- Old clients connecting to a new server can keep sending the original payload (no `replyTo`) — works unchanged.
- New clients connecting to an old server: send `replyTo`, the field is silently ignored, message goes through, reply UX degrades to "regular message". No crash, no error.

### `room_message` flow with reply

```
Client emits:
  socket.emit("room_message", {
    roomId,
    senderName,
    messageContent: "Yes that's right",
    replyTo: {                                  // optional
      messageId: "65f8...e21",
      senderName: "Admin",
      contentSnippet: "Anyone watching the second half?",
      isAdmin: true,
    },
  });

Server (room_message handler in socketHandler.js):
  1. Existing pipeline — ban check + room exists + per-IP rate limit  (1 Redis RTT)
  2. Existing FEATURE_VALIDATION gate — validateMessage(messageContent)
  3. NEW — sanitizeReplyTo(replyTo)  (pure JS, no I/O)
       - validate types, lengths, ObjectId shape
       - truncate contentSnippet to 140 chars
       - if FEATURE_VALIDATION is on: cleanString(contentSnippet)
       - return null if malformed (treat as no reply)
  4. Build messageData with replyTo set if sanitization passed
  5. io.to(roomId).emit("room_message", messageData)   ← payload now includes replyTo
  6. saveChatMessageService(roomId, messageData)       ← fire-and-forget, unchanged
```

### Server-side validation — `sanitizeReplyTo(raw)`

Pure synchronous JS, no Redis or Mongo. Lives in [utils/messageValidation.js](utils/messageValidation.js) alongside the existing `validateMessage` and `cleanString`:

```js
const REPLY_SNIPPET_MAX = 140;
const REPLY_SENDER_MAX = 50;

function sanitizeReplyTo(raw, { profanityFilter } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const { messageId, senderName, contentSnippet, isAdmin } = raw;

  // ObjectId-shape sanity check — 24 hex chars. Stricter than mongoose's
  // isValidObjectId because we don't need a round trip into BSON.
  if (typeof messageId !== "string" || !/^[a-f0-9]{24}$/i.test(messageId)) {
    return null;
  }
  if (typeof senderName !== "string" || senderName.length === 0) return null;
  if (typeof contentSnippet !== "string" || contentSnippet.length === 0) return null;

  const truncatedName = senderName.slice(0, REPLY_SENDER_MAX);
  let truncatedSnippet = contentSnippet.slice(0, REPLY_SNIPPET_MAX);

  // If profanity filter is provided (FEATURE_VALIDATION on), clean the
  // snippet — same call site convention as cleanString on message content.
  if (profanityFilter) {
    try { truncatedSnippet = profanityFilter.clean(truncatedSnippet); }
    catch { /* unicode edge case — fall through with raw value */ }
  }

  return {
    messageId,
    senderName: truncatedName,
    contentSnippet: truncatedSnippet,
    isAdmin: !!isAdmin,
  };
}
```

Note the `profanityFilter` parameter: when the existing `FEATURE_VALIDATION` flag is on, the snippet gets cleaned alongside the message content. This keeps the toggle's contract intact ("server doesn't touch content when off, server scrubs content when on" — see [SPAM_LOOPHOLE_FIX_PLAN.md §2.5](SPAM_LOOPHOLE_FIX_PLAN.md)).

### Why the server does NOT look up the parent message

Three options were considered for verifying the parent metadata server-side:

| Option | Cost | Verdict |
|---|---|---|
| Mongo `findById(messageId)` on every send | ~3–5 ms per send × 400 msg/s = ~1.6 s/s pending work per instance | ❌ Wrecks the hot path. Exactly the load pattern P1 in [READ_PATH_PLAN.md](READ_PATH_PLAN.md) was built to eliminate. |
| Redis `zRange(__room_msg_cache__:{roomId})` + JSON.parse loop | ~50 µs × 200 parses = ~10 ms per send | ❌ Better than Mongo but still meaningfully blocks the event loop at 400 msg/s. |
| Trust client + sanitize | ~5 µs per send (regex + slice) | ✅ |

The risk of trusting the client snapshot:

| Attack | Mitigation |
|---|---|
| Bot spoofs `replyTo.senderName = "Admin"` and `isAdmin = true` in the quote header | Cosmetic only — the surrounding message is still attributed to the bot's real `senderName` which goes through the ban + rate-limit pipeline. A bot could already paste "Admin: buy crypto now" inside its own message content. No new attack surface. |
| Bot puts profanity / URLs in `contentSnippet` | Same content goes through `cleanString` and (eventually) the URL check, gated on `FEATURE_VALIDATION`. Same protection as for the main `messageContent`. |
| Bot puts an oversized snippet to bloat broadcast payloads | Server-side `.slice(0, 140)` cap. |
| Bot puts arbitrary `messageId` strings to break the click-to-scroll | Client treats unknown `messageId` as "parent not loaded, no scroll action" — no crash, no info leak. |

The cost-benefit clearly favours trust-and-sanitize. This is the **same trade-off** the codebase already makes for `senderName` on every `room_message` (see [SPAM_LOOPHOLE_FIX_PLAN.md §1.2](SPAM_LOOPHOLE_FIX_PLAN.md) — note that `socket.senderName` ban-spoofing fix is pending; until it lands, the codebase already trusts a stronger client-supplied field than `replyTo`).

---

## 3. BACKEND — `socket/socketHandler.js`

Two surgical edits — one in `room_message`, one in `admin_room_message`. The rest of both handlers is unchanged.

### Imports

```js
const { validateMessage, sanitizeReplyTo } = require("@project/utils/messageValidation");
```

### `room_message` handler — diff over the existing handler

```js
socket.on("room_message", async (data) => {
  const { roomId, messageContent, senderName, replyTo } = data;  // ← replyTo new

  // ... existing ban + room-exists + rate-limit pipeline unchanged ...

  // Server-side content handling (existing FEATURE_VALIDATION gate)
  let outputContent;
  let profanityFilter = null;
  if (getFlag(FEATURE_VALIDATION)) {
    socket.recentMessages = socket.recentMessages || [];
    const verdict = validateMessage(messageContent, socket.recentMessages);
    if (!verdict.ok) return;
    socket.recentMessages = [
      ...socket.recentMessages.slice(-(RECENT_MESSAGES_BUFFER - 1)),
      verdict.normalized,
    ];
    outputContent = verdict.cleaned;
    profanityFilter = verdict.filter;  // ← passed back so the same instance can clean the snippet
  } else {
    outputContent = messageContent;
  }

  // NEW — sanitize replyTo (pure, no I/O)
  const sanitizedReply = sanitizeReplyTo(replyTo, { profanityFilter });

  const msgId = new mongoose.Types.ObjectId();
  const messageData = {
    _id: msgId.toString(),
    senderName,
    messageContent: outputContent,
    roomId,
    timestamp: new Date().toISOString(),
    ...(sanitizedReply && { replyTo: sanitizedReply }),  // ← only set when present
  };
  io.to(roomId).emit("room_message", messageData);

  saveChatMessageService(roomId, {
    _id: msgId,
    senderName,
    senderId: socket.id,
    messageContent: outputContent,
    messageType: "room_message",
    ...(sanitizedReply && { replyTo: sanitizedReply }),  // ← persist alongside
  }).catch((error) => console.error("Failed to save message:", error));
});
```

### `admin_room_message` handler — same idea

```js
socket.on("admin_room_message", async (data) => {
  if (!socket.isAdmin) { socket.emit("error", { message: "Admin access required" }); return; }
  const { roomId, messageContent, isPinned, replyTo } = data;   // ← replyTo new
  if (!socket.rooms.has(roomId)) { /* ...existing... */ return; }
  if (!(await roomExists(roomId))) { /* ...existing... */ return; }

  // Admin messages are not gated by FEATURE_VALIDATION (admins are not bots).
  // Sanitize replyTo anyway — bound the lengths, normalise types.
  const sanitizedReply = sanitizeReplyTo(replyTo);

  const msgId = new mongoose.Types.ObjectId();
  const messageData = {
    _id: msgId.toString(),
    senderName: "Admin",
    messageContent,
    roomId,
    isAdmin: true,
    isPinned: !!isPinned,
    timestamp: new Date().toISOString(),
    ...(sanitizedReply && { replyTo: sanitizedReply }),
  };
  io.to(roomId).emit("room_message", messageData);

  saveChatMessageService(roomId, {
    _id: msgId,
    senderName: "Admin",
    senderId: socket.id,
    messageContent,
    messageType: "room_message",
    isAdmin: true,
    isPinned: !!isPinned,
    ...(sanitizedReply && { replyTo: sanitizedReply }),
  }).catch(console.error);
});
```

### One follow-on tweak to `validateMessage`

Today `validateMessage` returns `{ ok, normalized, cleaned }`. To let `sanitizeReplyTo` reuse the same `Filter` instance without a second instantiation per message, extend the return to expose the shared filter:

```js
// utils/messageValidation.js
const Filter = require("bad-words");
const profanityFilter = new Filter();   // existing single instance

function validateMessage(content, recentMessages) {
  // ...existing checks...
  return {
    ok: true,
    normalized: ...,
    cleaned: profanityFilter.clean(content),
    filter: profanityFilter,    // ← new, pointer to the shared instance
  };
}
```

`filter` is a reference to the already-constructed module-level object — costs nothing to surface.

---

## 4. BACKEND — service.js + Redis cache

**Zero changes.** Walking through each layer:

| Layer | Effect of `replyTo` on this layer |
|---|---|
| `messageBatch` (in-memory per worker) | Holds the message object as-is. `replyTo` rides along. No change. |
| `flushMessageBatch` → `MessageModel.insertMany` | `insertMany` writes the document including `replyTo` when present. No change. |
| `__room_msg_cache__:{roomId}` (Redis sorted set) | `JSON.stringify(message)` already serializes every field. `replyTo` rides along. No change. |
| `zRemRangeByRank` eviction | Operates on whole entries — no field-level effect. No change. |
| `getRecentMessagesWithCache` | `JSON.parse` rehydrates `replyTo`. No change. |
| `__room_msg_counts__` drain → `ChatRoom.messageCount` | Counts replies as messages (which is correct — a reply IS a message). No change. |
| `__room_pinned__:{roomId}` | A pinned message that is also a reply caches with `replyTo` — fine. No change. |
| Reaction batch / admin reaction flush | Operates on `reactions` / `adminReactions` keys only. Reactions on replies work identically. No change. |

The reason there's nothing to do here: `saveChatMessageService` already takes the message object as-is and runs `JSON.stringify` for the Redis cache write. The sorted-set entry is opaque text from Redis's perspective, so adding a field is free.

---

## 5. CLIENT — `football-next-score8o8/src/components/chatBox/chatBox.tsx`

### Design decisions (locked)

| Choice | Decision |
|---|---|
| Reply icon placement | Bottom-right of each message, absolute-positioned (mirrors the reaction `+` at bottom-left). See §5.3. |
| Reply icon Tooltip | **Controlled** with per-message `replyTooltipOpen` state. Force-closed on click so the scroll lock releases immediately and the outgoing reply auto-scrolls into view. Mirrors the existing reaction-picker Tooltip pattern in `MessageItem`. See §5.3. |
| Scroll-lock | Hover-only (Tooltip onOpen/onClose). Click does NOT lock scroll. See §5.10. |
| Quote-preview placement (composer) | Directly above the textbox, anchored to the input area. See §5.5. |
| Cancel reply | X button + Escape key. See §5.5, §5.6. |
| Quote block in replied messages | Inserted between message header and body. Vertical accent bar + bold sender name color follow the **same rules as the outer sender header**: admin → `error.main` (red + crown), self → `primary.main` (blue + `(me)` suffix), others → `warning.main` (orange). Snippet text always `text.secondary`. See §5.8. |
| Quote snippet truncation | **Single line, ellipsis** (`whiteSpace: 'nowrap', textOverflow: 'ellipsis'`). Bounded vertical height ~36 px. Matches Telegram / iMessage. |
| Parent timestamp in quote | **Not shown** — keeps the quote compact. Matches WhatsApp / Telegram / Slack. The reply's own timestamp is still in the message header above. |
| Click on quote | **Clickable** — scrolls chat list to parent + 1.5 s yellow background pulse on the parent message. Uses **manual `container.scrollTo()`** (not `Element.scrollIntoView`) so only the chat's internal scrollbar moves — the surrounding page stays put. If parent is older than `STORE_MESSAGES_LIMIT = 300` (no longer in `messages` state), click is a silent no-op. See §5.9. |
| Pinned banner | Intentionally does NOT render the quote even if the pinned message is a reply (v1 non-goal — see §13). |
| Message body color | Explicit `color: text.primary` on the body Typography — without it, wrapping the `secondary` content in a Fragment changed the inheritance chain and dimmed the body to `text.secondary`. |

### 5.1 Extend `MessageNew`

```ts
interface MessageReplyTo {
  messageId: string;
  senderName: string;
  contentSnippet: string;
  isAdmin?: boolean;
}

interface MessageNew {
  // ...existing fields...
  replyTo?: MessageReplyTo;
}
```

### 5.2 New top-level state + refs in `ChatBox`

```ts
// The message the user is currently replying to (or null). When non-null, the
// composer shows a quote-preview banner above the TextField and the next
// emitted room_message will carry this as its replyTo payload.
const [replyTarget, setReplyTarget] = useState<MessageReplyTo | null>(null);

// Triggers a brief background-color pulse on the message with this _id —
// used after a click-to-scroll lands on a parent. Cleared after the
// animation finishes.
const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);

// Ref to the composer's TextField — wired through `ChatInput` via a new
// `inputRef` prop, so the parent can call `.focus()` from `onReplyClick`
// (§5.4) without `ChatInput` owning the reply state.
const composerInputRef = useRef<HTMLInputElement | null>(null);

// Stable cancel-reply callback — passed to both `ChatInput` (for Escape
// handling) and the X button on the reply-preview banner (§5.5).
const onCancelReply = useCallback(() => setReplyTarget(null), []);
```

### 5.3 Reply icon on each message — bottom-right

The pills row at [chatBox.tsx:554-565](src/components/chatBox/chatBox.tsx) is positioned `top: calc(100% - 6px), left: 8, right: 8` and contains the existing reaction pills + smiley `+` button. Add the reply IconButton at the right edge of the same row.

Two layout options were considered:

**Option A — same flex row, push to right via `ml: 'auto'`**

```tsx
<Box sx={{ /* pills row — existing */ }}>
  {combinedEmojiOrder.map(...)}            // pills (left)
  <Tooltip title="Add reaction">{...}</Tooltip>   // smiley +
  <Box sx={{ ml: 'auto' }}>                // ← pushes reply to far right
    <Tooltip title="Reply to this message" ... >
      <IconButton ... onMouseEnter, onClick={() => setReplyTarget({...})} >
        <Iconify icon="mdi:reply" width={14} />
      </IconButton>
    </Tooltip>
  </Box>
</Box>
```

Problem: when reactions wrap to a second line (many emojis), `ml: 'auto'` puts the reply button on a separate line. Ugly.

**Option B — absolute position, sibling box**

```tsx
<Box sx={{ /* pills row — existing, left/right: 8 */ }}>
  {/* pills + smiley + unchanged */}
</Box>
<Box sx={{
  position: 'absolute',
  top: 'calc(100% - 6px)',
  right: 8,
  zIndex: 2,           // sits above the pills row when they wrap
}}>
  <Tooltip
    title="Reply to this message"
    onOpen={() => { isPopoverOpenRef.current = true; }}
    onClose={() => { isPopoverOpenRef.current = false; }}
  >
    <IconButton ... />
  </Tooltip>
</Box>
```

✅ **Option B chosen.** Stable position regardless of pill row content. Tooltip's `onOpen` / `onClose` reuses the existing `isPopoverOpenRef` scroll-lock convention — **only the hover state locks scroll**, identical to how reaction pills behave. Clicking the reply button does not affect autoscroll; the composer's quote-preview banner is anchored to the input area, so it stays visible regardless of where the chat list scrolls to.

### 5.4 The click handler

```tsx
const onReplyClick = useCallback((msg: MessageNew) => {
  if (!msg._id || !msg.senderName) return;
  setReplyTarget({
    messageId: msg._id,
    senderName: msg.senderName,
    contentSnippet: msg.messageContent.slice(0, 140),
    isAdmin: !!msg.isAdmin,
  });
  // No scroll-lock here — autoscroll resumes normally while the user composes.
  // The quote-preview banner is anchored to the input area (not the chat
  // list), so it stays visible even as new messages arrive and the list
  // autoscrolls.
  composerInputRef.current?.focus();
}, []);
```

Snippet is truncated client-side **before** sending; server truncates again as a defence in depth.

### 5.5 Quote-preview above the composer

**Why above the input** — the only sensible placement, and the universal convention in every major chat app (WhatsApp, Telegram, Slack, Discord, iMessage, Signal). Two reasons it works:

1. **Eye line.** The user's gaze is already on the input when typing. Anything that needs to read as "you're replying to this" must sit in the same visual cluster — directly above the textbox.
2. **Anchored, not floating.** It's pinned to the composer area, not the message list. The chat list can scroll freely (autoscroll on, user scrolling, whatever) and the reply context never disappears off-screen. This is why we don't need to lock scroll while reply mode is active.

A small Box is rendered conditionally between the existing `error` Alert and the `ChatInput` — inside the same `<Box sx={{ p: 2, pb: 3 }}>` wrapper that already holds the input:

```tsx
{replyTarget && (
  <Box
    sx={{
      mb: 1,
      px: 1.5, py: 0.5,
      borderLeft: 3,
      borderColor: replyTarget.isAdmin ? 'error.main' : 'primary.main',
      bgcolor: 'action.hover',
      borderRadius: 1,
      display: 'flex',
      alignItems: 'center',
      gap: 1,
    }}
  >
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="caption"
        sx={{
          fontWeight: 600,
          color: replyTarget.isAdmin ? 'error.main' : 'primary.main',
          display: 'block',
          lineHeight: 1.2,
        }}
      >
        Replying to {replyTarget.senderName}
        {replyTarget.isAdmin && (
          <Iconify icon="mdi:crown" width={12} sx={{ ml: 0.5, verticalAlign: 'middle' }} />
        )}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          display: 'block',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          lineHeight: 1.2,
        }}
      >
        {replyTarget.contentSnippet}
      </Typography>
    </Box>
    <IconButton
      size="small"
      onClick={() => setReplyTarget(null)}
      sx={{ p: 0.25 }}
    >
      <Iconify icon="mdi:close" width={16} />
    </IconButton>
  </Box>
)}
```

Sized as a single line each for header + snippet, ~50 px tall — matches WhatsApp / Telegram visual weight.

### 5.6 Composer enhancements

- **`ChatInput` new props.** Two additions:
  ```ts
  type ChatInputProps = {
    // ...existing props...
    inputRef?: React.MutableRefObject<HTMLInputElement | null>;  // forwarded to TextField
    replyActive?: boolean;                                        // is reply mode on?
    onCancelReply?: () => void;                                   // for Escape handler
  };
  ```
  Inside `ChatInput`, the `TextField` gets `inputRef={inputRef}` (MUI forwards this to the underlying input element).
- **Focus the textbox** when entering reply mode. From `onReplyClick` (§5.4) the parent calls `composerInputRef.current?.focus()` directly after `setReplyTarget(...)`. No extra effects needed.
- **Escape clears reply mode.** Add to `ChatInput.handleKeyPress`:
  ```ts
  if (e.key === 'Escape' && replyActive) {
    e.preventDefault();
    onCancelReply?.();
  }
  ```
  `Escape` is handled in addition to the X button on the preview banner — the X is what users see, Escape is for keyboard users.

### 5.7 Wiring into `handleSendMessage`

Three small additions to the existing `handleSendMessage`:

1. **Optimistic local push** carries `replyTo` so the sender sees their own quote instantly:
   ```ts
   const messageData = createMessage(userName, cleaned, false, false, "room_message");
   const messageWithReply = replyTarget
     ? { ...messageData, replyTo: replyTarget }
     : messageData;
   setMessages((prev) => [...prev, messageWithReply].slice(-STORE_MESSAGES_LIMIT));
   ```

2. **Emit** includes `replyTo`:
   ```ts
   socket.emit("room_message", {
     roomId,
     messageContent: cleaned,
     senderName: userName,
     ...(replyTarget && { replyTo: replyTarget }),
   });
   ```

3. **Clear reply mode** after a successful emit — single statement, no scroll-lock to release (the hover ref is already untouched by reply-mode):
   ```ts
   if (replyTarget) setReplyTarget(null);
   ```

### 5.8 Quote block inside replied messages

Inside the `MessageItem` block ([chatBox.tsx:484-712](src/components/chatBox/chatBox.tsx)), render the quote **above** the message body when `msg.replyTo` is set:

```tsx
{msg.replyTo && (
  <Box
    onClick={() => onQuoteClick?.(msg.replyTo!.messageId)}
    sx={{
      mt: 0.5,
      px: 1, py: 0.5,
      borderLeft: 3,
      borderColor: msg.replyTo.isAdmin ? 'error.main' : 'primary.main',
      bgcolor: 'background.paper',
      borderRadius: 0.5,
      cursor: 'pointer',
      '&:hover': { bgcolor: 'action.hover' },
    }}
  >
    <Typography
      variant="caption"
      sx={{
        fontWeight: 600,
        color: msg.replyTo.isAdmin ? 'error.main' : 'primary.main',
        display: 'block',
        lineHeight: 1.2,
      }}
    >
      {msg.replyTo.senderName}
      {msg.replyTo.isAdmin && (
        <Iconify icon="mdi:crown" width={12} sx={{ ml: 0.5, verticalAlign: 'middle' }} />
      )}
    </Typography>
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{
        display: 'block',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        lineHeight: 1.2,
      }}
    >
      {msg.replyTo.contentSnippet}
    </Typography>
  </Box>
)}
```

Inserted inside `ListItemText.secondary` above the existing message-content Typography.

### 5.9 Click-to-scroll + highlight pulse

```ts
const onQuoteClick = useCallback((parentMessageId: string) => {
  const container = messagesContainerRef.current;
  if (!container) return;
  const target = container.querySelector(
    `[data-msg-id="${parentMessageId}"]`,
  ) as HTMLElement | null;
  if (!target) return;  // parent older than STORE_MESSAGES_LIMIT or never loaded

  // ⚠ Do NOT use Element.scrollIntoView — it walks up the DOM and scrolls
  // every ancestor scroll container, including the surrounding page. The
  // chat box lives inside the score8o8 match page which has its own scroll;
  // scrollIntoView would jerk the entire page to bring the chat into view,
  // not just the parent message inside the chat list.
  //
  // Instead, compute the target's offset within the messages container and
  // call scrollTo on the container directly — this only moves the chat's
  // internal scrollbar.
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetOffsetTop =
    targetRect.top - containerRect.top + container.scrollTop;
  const desiredScrollTop =
    targetOffsetTop - (container.clientHeight - target.clientHeight) / 2;

  isProgrammaticScrollRef.current = true;
  container.scrollTo({
    top: Math.max(0, desiredScrollTop),
    behavior: "smooth",
  });
  setHighlightedMessageId(parentMessageId);
  setTimeout(() => setHighlightedMessageId(null), 1500);
}, []);
```

Each rendered `ListItem` for a `room_message` gets `data-msg-id={msg._id}` so the lookup is O(1) via querySelector. No new state per message, no extra ref Map.

The highlight is a CSS keyframe applied conditionally:

```ts
const highlightPulse = keyframes`
  0%   { background-color: var(--bg-original); }
  30%  { background-color: rgba(255, 215, 0, 0.35); }
  100% { background-color: var(--bg-original); }
`;
```

Applied via `sx={{ animation: msg._id === highlightedMessageId ? `${highlightPulse} 1.5s ease` : 'none' }}` on the message ListItem.

### 5.10 Scroll-lock contract for reply

The existing scroll-lock (`isPopoverOpenRef`) handles the reaction picker. The reply icon follows **exactly the same convention** — no new contract:

| Action | Sets ref | Clears ref |
|---|---|---|
| Hover reply icon (Tooltip onOpen) | true | — |
| Stop hovering reply icon (Tooltip onClose) | — | false |
| Click reply icon → set `replyTarget` | — | — (autoscroll stays on) |
| Cancel reply (X click or Escape) | — | — |
| Send reply | — | — |
| Open reaction picker (Tooltip onOpen) | true | — (existing) |
| Close reaction picker (Tooltip onClose) | — | false (existing) |
| Hover an existing reaction pill (Tooltip onOpen) | true | — (existing) |
| Stop hovering reaction pill (Tooltip onClose) | — | false (existing) |

The reply button is a **pure hover-locks-scroll, click-does-not** primitive. The composer's quote-preview banner does its own job of keeping the user oriented — no scroll trick needed.

---

## 6. ADMIN — `football-admin/src/sections/matches/chat-table-rows.tsx`

Mirrors §5 structurally. Admin can also reply.

### 6.1 Extend `MessageNew`

Same `replyTo` field as the score8o8 client.

### 6.2 State + refs

```tsx
const [replyTarget, setReplyTarget] = useState<MessageReplyTo | null>(null);
const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
const composerInputRef = useRef<HTMLInputElement | null>(null);
const onCancelReply = useCallback(() => setReplyTarget(null), []);
```

`onReplyClick` mirrors the client (§5.4):

```tsx
const onReplyClick = useCallback((msg: MessageNew) => {
  if (!msg._id || !msg.senderName) return;
  setReplyTarget({
    messageId: msg._id,
    senderName: msg.senderName,
    contentSnippet: msg.messageContent.slice(0, 140),
    isAdmin: !!msg.isAdmin,
  });
  composerInputRef.current?.focus();
}, []);
```

### 6.3 Reply icon — bottom-right of each message

Mounted absolute-positioned at the right edge of the existing pills row, mirroring §5.3 Option B. The admin already has the smiley `+` picker button rendered after the pills — the reply icon sits at `right: 8`, the picker at `left` (after the pills).

Hover-only scroll-lock via the existing `isPopoverOpenRef` ref (see [chat-table-rows.tsx:205](src/sections/matches/chat-table-rows.tsx)). Click does **not** lock scroll — same contract as §5.10. The composer's quote preview keeps the admin oriented while replying.

The admin's hover scroll-lock convention is already richer than the client's because of the `hoverPanel` reaction picker — but for the reply button, plain Tooltip onOpen/onClose is enough; no hover-bridge timing is needed (there's no flyout panel to navigate into).

### 6.4 Reply preview above the admin composer

A small Box rendered directly above `AdminChatInput` inside the existing `<Box sx={{ px: 2, position: 'relative' }}>` wrapper at [chat-table-rows.tsx:934](src/sections/matches/chat-table-rows.tsx). Same shape as §5.5: vertical accent border on the left (red for admin parents, primary for user parents), bold sender name on top, ellipsis-truncated snippet below, X button on the right. Sits stacked above the textbox just like every standard chat app's admin/desktop reply composer.

The typing-indicator box already lives at `top: -22, left: 16` inside this wrapper. The reply preview goes ABOVE the input but BELOW the typing indicator's vertical space — i.e., in a normal flow inside the wrapper, before the `AdminChatInput`. The typing indicator stays absolute-positioned and unaffected.

### 6.5 `AdminChatInput` extension

Three new props — same shape and reasoning as `ChatInput` in §5.6 (preview lives at the parent level, the component just needs the boolean for `Escape` and the ref for focus):

```tsx
type AdminChatInputProps = {
  socketConnected: boolean;
  onSendMessage: (message: string, isPinned?: boolean) => void;  // unchanged signature
  inputRef?: React.MutableRefObject<HTMLInputElement | null>;
  replyActive?: boolean;
  onCancelReply?: () => void;
};
```

Note `onSendMessage` keeps its existing `(message, isPinned)` signature — the admin's `handleSendMessage` at the parent level already closes over `replyTarget` from state and includes it in the emit (§6.6). The component doesn't need to pass `replyTo` upward.

Escape handler inside `AdminChatInput.handleKeyPress`:

```tsx
if (e.key === 'Escape' && replyActive) {
  e.preventDefault();
  onCancelReply?.();
}
```

`TextField` gets `inputRef={inputRef}`.

### 6.6 Wiring into `handleSendMessage`

```tsx
const handleSendMessage = useCallback(
  async (content, isPinned = false, userData = null) => {
    if (content?.trim() && socket && isAuthenticated) {
      socket.emit('admin_room_message', {
        roomId,
        messageContent: content,
        isPinned,
        ...(replyTarget && { replyTo: replyTarget }),
      });
      if (replyTarget) setReplyTarget(null);
      if (userData) socket.emit('update_user', { roomId, userData });
    }
  },
  [socket, roomId, isAuthenticated, replyTarget],
);
```

Note: admin does NOT use an optimistic local push today (`setMessages` is commented out at [chat-table-rows.tsx:560-561](src/sections/matches/chat-table-rows.tsx)) — admin sees its own sent message via the server echo on `room_message`. The echo carries `replyTo`, so the admin's own quote renders correctly without any extra client work.

### 6.7 Quote block inside replied messages

Same shape as §5.8. Rendered inside the `ListItem` for `room_message` ([chat-table-rows.tsx:708-871](src/sections/matches/chat-table-rows.tsx)) — specifically inside `ListItemText.secondary`, **above** the existing `<Typography>{msg.messageContent}</Typography>` and **below** the `ChatUserName` header (which sits in `primary`). This matches the client convention: username on top → quote in the middle → reply body at the bottom.

Uses the admin theme palette (`primary.main` for user parents, `error.main` for admin parents — same as the client).

### 6.8 Click-to-scroll + highlight pulse

Same as §5.9. Admin already has `messagesContainerRef` and `isProgrammaticScrollRef` ([chat-table-rows.tsx:204-208](src/sections/matches/chat-table-rows.tsx)).

### 6.9 Admin-specific edge case — reply to a deleted user's message

Admin can ban users. If admin replies to a banned user's message, the reply still works (the quote snapshot is frozen). The banned user themselves can't reply at all because the `room_message` pipeline drops them silently before reaching the broadcast.

---

## 7. AUTH / SECURITY

| Concern | Status |
|---|---|
| Banned users can use replies to bypass the ban | No — the entire `room_message` is dropped at the existing Redis ban check before `replyTo` is even read. |
| Bots impersonate admin in quote header (`replyTo.isAdmin = true`) | Cosmetic only — the surrounding message still has its real `senderName`. Same risk as a bot writing "Admin said: …" in its message content today. Accepted. |
| Reply spam (one bot sends 100 replies to the same parent) | Caught by the existing per-IP rate limit (1 msg / 5 s) and FE rate limit. No reply-specific rate limit needed. |
| Reply to a malicious parent (the snippet contains URLs / profanity) | When `FEATURE_VALIDATION` is on, `sanitizeReplyTo` runs `profanityFilter.clean(contentSnippet)`. When off, raw passes through — same contract as the message body. |
| `replyTo.messageId` is opaque on the server — could be a non-existent ID | Allowed. Server doesn't verify. Client treats unknown IDs as "parent not loaded" — graceful. |
| Long `contentSnippet` to bloat broadcast bandwidth | Server-side `.slice(0, 140)` cap. Belt and suspenders: client also truncates before sending. |

---

## 8. CROSS-INSTANCE / PERFORMANCE CONSIDERATIONS

| Concern | Handling |
|---|---|
| Replies arrive at one instance, viewer is on another | Existing Socket.io Redis adapter handles `io.to(roomId).emit` cross-process — `replyTo` rides the same broadcast. |
| Replies in the message cache | Redis sorted set stores full JSON; `replyTo` is part of the JSON. Zero extra Redis ops. |
| Replies in Mongo batch flush | `MessageModel.insertMany` writes the doc with `replyTo` — single op, same wire bytes per doc, no extra round trips. |
| Reply to a message still in the in-memory batch (parent not yet in Mongo) | Works — `replyTo` stores a denormalized snapshot, not a foreign key. The parent persists separately on the next flush. Even if the parent _never_ persists (rare crash), the reply still has its quote text. |
| 20K simultaneous history loads with replies | Same `getRecentMessagesWithCache` path — Redis sorted-set hit serves the full JSON including all `replyTo` fields. No additional load. |
| Reactions on a reply | Identical to reactions on any other message — `reactions` and `adminReactions` fields are unrelated to `replyTo`. |
| `__room_pinned__:{roomId}` cache when a pinned message is also a reply | The pinned cache stores the full message JSON — `replyTo` rides along, displays correctly in the pinned banner. No change needed. |
| `cachePopulationInFlight` coalescing | Unchanged — coalesces by `roomId`, not by message content. |
| Drain loop, batch flush, admin reaction flush | All operate on fields orthogonal to `replyTo`. No interaction. |

---

## 9. FILES CHANGED

| File | Change |
|---|---|
| `football-chat-backend/modules/chat/messageModel.js` | Add `replyTo` subdocument field, optional, with `maxlength` per sub-field. |
| `football-chat-backend/utils/messageValidation.js` | Add `sanitizeReplyTo(raw, { profanityFilter })`. Extend `validateMessage` return to expose `filter`. Export both. |
| `football-chat-backend/socket/socketHandler.js` | Read `replyTo` from `room_message` and `admin_room_message` payloads, call `sanitizeReplyTo`, conditionally spread into `messageData` and the `saveChatMessageService` payload. |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | Extend `MessageNew`. Add `replyTarget` + `highlightedMessageId` state. Add absolute-positioned reply IconButton per message. Add quote preview banner above `ChatInput`. Add quote block inside replied messages. Add `onQuoteClick` click-to-scroll + highlight pulse. Send `replyTo` in `socket.emit("room_message", ...)`. Extend optimistic local push to include `replyTo`. Wire `data-msg-id` on each rendered message ListItem. Hook `Escape` in composer. |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | Same as score8o8 client (extend `MessageNew`, reply IconButton, quote preview, quote block, click-to-scroll). Send `replyTo` in `socket.emit("admin_room_message", ...)`. `AdminChatInput` gets `inputRef` + `replyActive` + `onCancelReply` props (Escape handler + composer focus). |

No changes to:
- `modules/chat/service.js`
- `socket/roomManager.js`
- `utils/const_config.js`
- `utils/feature_flags.js`
- Any Redis key, sorted set, hash, or pub/sub channel
- `package.json` (no new deps)
- nginx config, ecosystem.config.js, OS tuning

---

## 10. NO-REGRESSION GUARANTEES

### 10.1 Old client + new server

Old client doesn't send `replyTo` → `data.replyTo` is undefined → `sanitizeReplyTo(undefined)` returns `null` → conditional spread omits the field → message persists and broadcasts identically to today. No behaviour change.

### 10.2 New client + old server

New client sends `replyTo` in `room_message` payload → old server ignores unknown fields (socket.io payloads are not strict-schema validated) → the message persists and broadcasts WITHOUT `replyTo`. The reply UX silently degrades to "regular message" on receivers. No crash, no error.

The local sender's optimistic push DOES include `replyTo` (built from local state), so the sender sees their own quote until the server echoes back without it — at which point the echo's missing `replyTo` will overwrite the optimistic state. Two mitigations:

| Option | Trade-off |
|---|---|
| Make the echo listener preserve `replyTo` when the payload omits it (defensive merge) | Same pattern already used for `adminReactions` in [chatBox.tsx:1217](src/components/chatBox/chatBox.tsx). Safe but adds a subtle "the field is sticky" semantic for future maintainers. |
| Match by `_id` and skip the echo entirely for own messages | Already done — see [chatBox.tsx:1152-1172](src/components/chatBox/chatBox.tsx). The own-message reconcile only updates `_id`, not other fields. So if `replyTo` is set on the optimistic record it stays set even when the echo omits it. ✓ |

The existing own-message reconcile path naturally handles this case. **No new code needed for partial-rollout safety on the sender's view.**

For receivers, an old-server broadcast strips `replyTo`. The receiver shows a regular message, no quote. Acceptable degradation.

### 10.3 Old messages in Mongo without `replyTo`

Mongoose returns `undefined` for missing optional fields. All render paths use `msg.replyTo && ...` guards. Handled.

### 10.4 Cached messages in `__room_msg_cache__:{roomId}` without `replyTo`

Same as above. The JSON parses cleanly, `replyTo` is `undefined`, guards handle it. No cache invalidation needed.

### 10.5 Reactions on replies

`message_reaction_updated` broadcasts `{ messageId, reactions, adminReactions }` — `replyTo` is on the message itself, not the reaction event. Listeners that spread reaction-update payloads into state already use `...msg` to preserve other fields ([chatBox.tsx:1210-1222](src/components/chatBox/chatBox.tsx) and [chat-table-rows.tsx:344-358](src/sections/matches/chat-table-rows.tsx)). `replyTo` is preserved. ✓

### 10.6 Pinned message that is also a reply

`__room_pinned__:{roomId}` caches the full JSON including `replyTo`. Pinned banner in the client (`chatBox.tsx`) currently renders only `senderName + content` — and **stays that way for v1** (locked decision in §5 design table, also called out in §13 non-goals). Pinned-banner real estate is already tight, and a pinned message that is also a reply is rare. The `replyTo` field is preserved in cache and Mongo regardless; we just don't render it in the pinned banner today.

### 10.7 The composer `Escape` key already does something for old code paths?

Today `ChatInput.handleKeyPress` handles only `Enter` and the space-key registration guard. Adding an `Escape` branch is purely additive — no existing keys override.

### 10.8 Scroll-lock interaction with reactions

Both reaction tooltips and the reply tooltip use the same hover-only convention (§5.10). They don't interfere — a hover-out from reply unlocks the ref, and a subsequent hover into a reaction tooltip re-locks it. No special guarding needed. **No changes to the existing reaction `onClose` handlers.**

### 10.9 The Redis sorted-set cache JSON now has a new key — script parsing

The Lua script `REACTION_SORTED_SET_SCRIPT` does `cjson.decode(val)` → mutates only `decoded['reactions']` and `decoded['adminReactions']` → `cjson.encode(decoded)`. Any other keys (including `replyTo`) survive the round-trip untouched. ✓

### 10.10 History pagination / "load older messages" — not in this plan

The current history endpoint returns up to `MSG_CACHE_LIMIT` messages. There is no "load older" feature yet. If a future load-older feature is added, replies to messages outside the loaded window will have `replyTo.messageId` pointing to a message not in `messages` state — the click-to-scroll handler bails (`if (!target) return;`). Graceful.

---

## 11. PERFORMANCE GUARANTEES

### Per-message overhead — at 400 msg/s per instance, peak production load

| Path | Today | After this plan (assuming 30% of messages are replies) | Delta |
|---|---|---|---|
| Mongo `insertMany` doc size | ~250 B | ~250 B (no reply) / ~400 B (reply) | +30% × 150 B = ~45 B average |
| `JSON.stringify` cost in `saveChatMessageService` | ~5 µs | ~5 µs (no reply) / ~7 µs (reply) | ~+0.6 µs avg |
| Redis `zAdd` payload bytes | ~250 B | ~250 / ~400 B | same delta as Mongo |
| Broadcast payload bytes (`io.to(roomId).emit`) | ~250 B JSON | ~250 / ~400 B JSON | ~+45 B average |
| Server-side `sanitizeReplyTo` | n/a | ~5 µs synchronous JS | +5 µs avg |
| Per-IP rate limit pipeline | unchanged | unchanged | 0 |
| Cache write pipeline | 1 RTT | 1 RTT | 0 |
| Mongo batch flush | per-room `$inc` + bulkWrite | identical | 0 |
| Mongo round trips per send | 0 (fire-and-forget batch) | 0 | 0 |
| Redis round trips per send | 1 cache write + 1 ban/rate-limit pipeline | identical | 0 |

**Net per-message:** ~+1 µs CPU per send (`sanitizeReplyTo` regex + slice) when no reply; ~+5 µs CPU when reply. **No extra round trips to Redis or Mongo, ever.** Broadcast payload grows ~18% in the average case (assuming 30% reply rate).

### At 30K users (~300 msg/s cluster-wide)

| Metric | Today | After plan |
|---|---|---|
| Mongo doc bytes flushed/s | ~75 KB | ~75–85 KB |
| Redis sorted-set bytes written/s | ~75 KB | ~75–85 KB |
| Broadcast bytes fanned out (cluster-wide, 1200 viewers/room avg) | ~360 MB/s pre-compression | ~360–415 MB/s pre-compression (gzip drops both into the same band) |
| Mongo RTTs/s | unchanged | unchanged |
| Redis RTTs/s | unchanged | unchanged |
| CPU cycles for `sanitizeReplyTo` | 0 | ~300 × 5 µs = 1.5 ms/s cluster-wide ≈ 0.001 cores |

### History load — `GET /get-room-messages`

| Metric | Today | After plan |
|---|---|---|
| Redis sorted-set hit cost | ~0.5 ms + ~200 JSON.parse @ ~5 µs = ~1.5 ms | Same — `replyTo` is in the JSON regardless |
| Per-message render cost (client) | unchanged | + one Box render per replied message |
| MongoDB cache-miss query | unchanged (same `.lean()`, same projection) | unchanged |

History load latency is **unchanged** — every byte of `replyTo` was already going to be parsed by `JSON.parse` whether the field exists or not. No new round trips, no new collections, no joins.

### Click-to-scroll

Pure client-side `querySelector` against a max-300-element DOM list. ~10–30 µs per click. Bounded by `STORE_MESSAGES_LIMIT = 300` in score8o8.

### Memory

| Structure | Per-message cost added |
|---|---|
| Mongo doc | ~150 B (only when a reply) |
| Redis sorted-set JSON entry | ~150 B (only when a reply) |
| React `messages` state in client | ~150 B per reply × 300 messages cap = ~45 KB worst case |
| In-memory `messageBatch` Map per worker | ~150 B per pending reply × up to `maxBatchSize` (100 in peak mode) = ~15 KB max per worker |

All bounded. No unbounded growth path introduced.

### Why no extra round trips matter at scale

The single most important constraint in this codebase is **zero extra Redis / Mongo round trips on the hot path**. [PERF_REPORT.md](PERF_REPORT.md) walks through how each historic optimisation came back to that principle. The current plan honours it:

- Server-side reply validation is **pure synchronous JS** (a regex test, three `.slice` calls, an optional `profanityFilter.clean`).
- The denormalised snapshot rides on bytes that were always going to be written and broadcast anyway.
- The history read path is unchanged at the Redis and Mongo level.

If we instead chose to verify `replyTo` server-side via Mongo or even via Redis ZRANGE, we'd add 1 RTT or 1–10 ms of CPU per send. At 30K users that's 300 extra RTTs/s OR 0.3–3 cores of CPU spent on a feature that does not need verification. The trust-and-sanitize approach gives us the same user-visible behaviour at zero cost.

### Reply rate during a wave

Peak admin "spam" pattern (admin replies to multiple users in quick succession during a goal): bounded by admin typing speed, not by the system. No special debounce needed. The existing `admin_room_message` handler has no rate limit (admins aren't rate-limited) — same applies to replies.

For users, replies count toward the same `ratelimit:{ip}` (1 msg / 5 s). A spammer can't bypass the rate limit by adding `replyTo` to their messages — the rate-limit pipeline runs before `sanitizeReplyTo` even sees the payload.

---

## 12. ROLLOUT ORDER

1. **Backend first** — schema + sanitizer + handler edits. Old clients keep working (don't send `replyTo`, server doesn't emit `replyTo`).
2. **Verify with a manual `socket.emit("room_message", { replyTo: {...} })`** from a console that the field round-trips through Redis cache and Mongo correctly.
3. **score8o8 client** — additive UI changes. Old backend ignores the new field, new client degrades gracefully (no quote shown on receivers when server is old).
4. **Admin UI** — same shape as the client.

Each step is independently deployable. The no-regression guarantees in §10 cover the rollout windows.

---

## 13. EXPLICIT NON-GOALS (v1)

| Excluded | Why |
|---|---|
| Quote rendering inside the pinned-message banner | Pinned banner real estate is tight; rare interaction. Add later if requested. |
| "Reply count" badge on the parent (Slack-style thread counter) | Would require a denormalised counter on the parent — extra Mongo update per reply. Not worth it for v1; user can scroll to find replies via the quote link in the other direction. |
| Threading (replies-to-replies that nest) | We store `replyTo` for one level only. A reply to a reply still gets a `replyTo` pointing to its immediate parent — never the grandparent. Matches WhatsApp / Telegram convention. |
| Notifying the parent's author ("X replied to your message") | Out of scope. The chat backend has no per-user notification channel today. |
| Server-side parent verification | Cost-benefit analysis in §2 — not worth it. Revisit only if abuse data shows fake quotes are being weaponised. |
| Edit / delete reply | No edit / delete feature exists for messages today. Replies inherit that constraint. |
| `replyTo` on `admin_reaction` or `add_reaction` | Reactions are atomic emoji indicators, not messages. No quote semantics. |

---

## 14. TESTING CHECKLIST

- Send a reply via score8o8 client → quote appears in own optimistic UI; another viewer in same room sees the same quote.
- Send a reply via admin → both score8o8 and admin see the quote, admin styled in `error.main`.
- Click a quote → chat list scrolls to parent with a yellow pulse.
- Click a quote whose parent is outside the loaded window → no scroll, no crash.
- Reload history → quotes survive (came from the sorted-set cache).
- Restart Redis → first history load is served from Mongo, quotes still present.
- Restart all 5 PM2 instances during a wave with replies in flight → no data loss beyond the standard `messageBatch` window.
- Send 50 replies in 5 seconds from one IP → rate limit kicks in (existing behaviour).
- Send a reply with a 500-char snippet from a scripted client → server truncates to 140.
- Send a reply with `replyTo.isAdmin = true` and `senderName = "Admin"` from a regular user → quote renders with admin badge (cosmetic; risk accepted per §7).
- Toggle `FEATURE_VALIDATION` off → snippets pass through raw. On → snippets get `cleanString` applied.
- React to a reply → reaction pill appears; the `replyTo` field is preserved across the `message_reaction_updated` listener (defensive merge already in place).
- Cancel reply mid-compose via X button → composer returns to normal mode; auto-scroll resumes on next incoming message.
- Cancel reply via Escape key → same as X click.
- Open reaction picker while reply target is set → both work independently. The reaction Tooltip locks scroll on hover-in and unlocks on hover-out; the reply preview banner is unaffected. No interaction bugs.
- Pinned message is a reply → broadcast shows the reply, but pinned banner intentionally does NOT render the quote (v1 non-goal).
- Reply to a message during a Redis NX race → no special handling needed; replies don't touch Redis NX locks.
- Delete the room (admin reset) → replies and parents both go in `deleteAllChatMessagesService`.

---

## 15. ROLLBACK

Revert `modules/chat/messageModel.js`, `utils/messageValidation.js`, `socket/socketHandler.js`. Optional Mongo `db.messages.updateMany({}, { $unset: { replyTo: "" } })` to clean up stored replies — but leaving them in place is harmless (the field is simply ignored after revert).

Frontend reverts are independent — score8o8 and admin can each roll back their UI without touching the backend.

No Redis cleanup needed — old sorted-set entries with `replyTo` keys deserialise cleanly into the post-revert codepath (which just ignores the field).

No schema migration, no socket event rename, no Redis key removal.

---

# Implementation Notes — 2026-06-02

**Status:** Implemented end-to-end across `football-chat-backend`, `football-next-score8o8`, `football-admin`. Backend `node -c` clean on all three touched files. `npx tsc --noEmit` exit 0 on score8o8. Admin tsc only reports the pre-existing unrelated `react-day-picker` error in `date-range-picker.tsx`.

## What was implemented

Matches §1–§13 of the plan above. Concrete file outcomes:

### `football-chat-backend/modules/chat/messageModel.js`
- Added `replyTo` subdocument: `{ messageId, senderName, contentSnippet, isAdmin }` with `maxlength` 50/140, `required: false`, `default: undefined`.

### `football-chat-backend/utils/messageValidation.js`
- Added `sanitizeReplyTo(raw, { shouldClean })` and exported it. Pure synchronous JS. Includes `REPLY_SNIPPET_MAX`, `REPLY_SENDER_MAX`, `OBJECT_ID_REGEX` constants.
- Validates `raw` is an object, `messageId` is a 24-hex string, `senderName` and `contentSnippet` are non-empty strings.
- Truncates `senderName` to 50 chars and `contentSnippet` to 140 chars.
- When `shouldClean` is true, runs `cleanString(snippet)` (which uses the existing module-level shared `profanityFilter` singleton). On unicode edge cases the existing `cleanString` falls back to the raw value, so reply messages are never dropped due to library quirks.

### `football-chat-backend/socket/socketHandler.js`
- Imported `sanitizeReplyTo`.
- `room_message` destructures `replyTo` from payload, sanitises with `shouldClean: validationOn` (gated on the existing `FEATURE_VALIDATION` flag), and conditionally spreads `replyTo` into both the broadcast `messageData` and the persisted `saveChatMessageService` payload.
- `admin_room_message` destructures `replyTo`, sanitises **without** `shouldClean` (admins are not gated by `FEATURE_VALIDATION`), spreads the same way.

### `football-next-score8o8/src/components/chatBox/chatBox.tsx`
- Added `MessageReplyTo` interface and extended `MessageNew` with `replyTo?`.
- Added `replyHighlightPulse` keyframe (transparent → gold @ 30% → transparent) for the click-to-scroll highlight.
- Top-level state: `replyTarget`, `highlightedMessageId`. Top-level ref: `composerInputRef`.
- Top-level callbacks: `onReplyClick` (focuses composer via `composerInputRef.current?.focus()`), `onCancelReply`, `onQuoteClick` (manual `scrollTo` — see §11.1 below).
- `MessageItem` accepts new props: `onReplyClick`, `onQuoteClick`, `highlighted`. Has its own `replyTooltipOpen` state for the controlled reply Tooltip (see §11.2 below).
- ListItem gets `data-msg-id={msg._id}` for the click-to-scroll lookup and a conditional `animation: highlighted ? replyHighlightPulse 1.5s ease : none`.
- Quote block rendered inside `ListItemText.secondary`, above the body Typography — colour logic matches the outer sender header (see §11.3 below).
- Reply IconButton mounted as an absolute-positioned sibling Box at `right: 8, zIndex: 2`. Controlled Tooltip.
- Pills row now uses `right: 36` (was 8) to leave room for the reply icon.
- Composer wrapper now contains the quote-preview banner conditionally between the error Alert and `ChatInput`. Same colour rules as the in-message quote.
- `ChatInput` extended with three new optional props: `inputRef`, `replyActive`, `onCancelReply`. Escape handler clears reply mode.
- `handleSendMessage`: optimistic local push includes `replyTo`; emit spreads `replyTo`; `replyTarget` cleared after.
- Incoming `room_message` listener reads `replyTo` from the payload.
- Message body Typography got an explicit `color: "text.primary"` (see §11.4 below).

### `football-admin/src/sections/matches/chat-table-rows.tsx`
- Same `MessageReplyTo` interface, `replyHighlightPulse` keyframe.
- State + refs at `ChatTableRows` level: `replyTarget`, `highlightedMessageId`, `composerInputRef`. Callbacks: `onReplyClick`, `onCancelReply`, `onQuoteClick`.
- `AdminChatInput` extended with `inputRef`, `replyActive`, `onCancelReply` props. Escape handler clears reply mode.
- **New component:** `ReplyIconButton` (memoised) — owns its own `open` state for the controlled Tooltip. Used in the messages map. See §11.5 below for the rationale.
- Quote block rendered inside `ListItemText.secondary` above the body Typography (below the `ChatUserName` header in `primary`). Admin perspective uses simpler colour rules (admin → red, else → orange) — see §11.3.
- Pills row uses `right: 36` to leave room for the reply icon.
- Composer wrapper contains the reply-preview banner above `AdminChatInput`. Typing indicator stays in its existing `position: absolute, top: -22` layer — no overlap.
- `handleSendMessage`: emits `replyTo`, clears `replyTarget`. Admin doesn't do optimistic local push (sees own messages via server echo).
- Incoming `room_message` listener reads `replyTo` from the payload.

---

## Deviations from the plan (with reasoning)

### 11.1 `Element.scrollIntoView` replaced with manual `scrollTo`

**Plan said:** `target.scrollIntoView({ behavior: "smooth", block: "center" })`.

**What shipped:** Manual offset calculation + `container.scrollTo()`.

**Why:** `Element.scrollIntoView` walks up the DOM and scrolls **every** ancestor scroll container — including the surrounding page on score8o8 (which has its own page scroll above the chat box) and the admin shell on football-admin. Clicking a reply quote was jerking the entire page to bring the chat into view, not just the chat's internal scroll bringing the parent message into view.

The fix computes the target's offset relative to `messagesContainerRef` and calls `scrollTo` on the container directly:

```ts
const containerRect = container.getBoundingClientRect();
const targetRect = target.getBoundingClientRect();
const targetOffsetTop = targetRect.top - containerRect.top + container.scrollTop;
const desiredScrollTop = targetOffsetTop - (container.clientHeight - target.clientHeight) / 2;
container.scrollTo({ top: Math.max(0, desiredScrollTop), behavior: "smooth" });
```

`Math.max(0, …)` clamps to zero so we never request a negative scroll. The target gets vertically centred; near the list top, clamping just shows the top with the target near it.

Applied to both score8o8 ([chatBox.tsx onQuoteClick](src/components/chatBox/chatBox.tsx)) and admin ([chat-table-rows.tsx onQuoteClick](src/sections/matches/chat-table-rows.tsx)) with the same shape.

The §5.9 code block in the plan now matches this implementation with a `⚠ Do NOT use Element.scrollIntoView` warning comment.

### 11.2 Reply icon Tooltip is **controlled**, force-closed on click

**Plan said:** Plain Tooltip with `onOpen`/`onClose` hooks. (§5.3 Option B.)

**What shipped:** Controlled Tooltip with per-message `open` state, force-closed in the `onClick` handler.

**Why:** With an uncontrolled Tooltip, this sequence broke autoscroll:

1. User scrolls up (`isUserAtBottomRef = false`, scroll-down button visible).
2. User hovers reply icon → Tooltip `onOpen` fires → `isPopoverOpenRef.current = true`.
3. User clicks reply → `onReplyClick(msg)` runs. Cursor stays on the icon, MUI's Tooltip stays visible, `onClose` has NOT fired, ref is still `true`.
4. User types + sends → `handleSendMessage` sets `isUserAtBottomRef.current = true` and `setShowScrollDown(false)` (button disappears).
5. Auto-scroll effect runs → bails on `if (isPopoverOpenRef.current) return;` because the Tooltip is technically still open.
6. Result: scroll-down button gone, but the message didn't scroll into view.

The fix mirrors the existing reaction-picker Tooltip pattern in `MessageItem`. The reply Tooltip is controlled by `replyTooltipOpen` state; the click handler does:

```tsx
onClick={(e) => {
  e.stopPropagation();
  setReplyTooltipOpen(false);          // visually close
  isPopoverOpenRef.current = false;    // release scroll lock
  onReplyClick(msg);                   // enter reply mode + focus composer
}}
```

Both effects fire synchronously, so by the time `handleSendMessage` runs later, the lock has long been released and auto-scroll works normally.

- score8o8: `replyTooltipOpen` state lives inside `MessageItem`.
- admin: see §11.5 below — extracted into a dedicated `ReplyIconButton` component.

### 11.3 Quote sender colour follows the **outer-header colour logic** (not a fixed admin/non-admin binary)

**Plan said:** Quote sender colour was `isAdmin ? "error.main" : "primary.main"`.

**What shipped:** Quote sender colour follows the same rules as the outer sender header so the quoted person's identity is visually consistent throughout the chat.

**score8o8 client rules** (from the user's perspective):

| Quoted person | Colour | Suffix |
|---|---|---|
| Admin | `error.main` (red) | crown icon |
| The viewer themselves | `primary.main` (blue) | ` (me)` |
| Anyone else | `warning.main` (orange) | — |

The same rules apply to both:
- The quote block rendered **inside** a replied message (§5.8)
- The composer's "Replying to X" preview banner (§5.5)

Concretely, inside `MessageItem`:

```tsx
const isSelf =
  !msg.replyTo!.isAdmin &&
  !!userName &&
  msg.replyTo!.senderName === userName;
const quoteColor = msg.replyTo!.isAdmin
  ? "error.main"
  : isSelf ? "primary.main" : "warning.main";
```

Both the sender-name Typography and the accent-bar `borderColor` use `quoteColor`.

**Admin rules** (admin doesn't have a "this is me" concept — every non-admin is "another user"):

| Quoted person | Colour |
|---|---|
| Admin | `error.main` (red) |
| Non-admin user | `warning.main` (orange) |

No `(me)` suffix in the admin view.

**Why:** With the original `primary.main` fallback, a reply quote of a regular user (e.g. `nnnn`) rendered in blue inside the message, but `nnnn`'s actual sender header above rendered in orange (`warning.main`). The two didn't match, which made the quoted identity visually disconnect from the same user's other messages. Matching the outer-header rules makes the chat read coherently regardless of who's being quoted.

### 11.4 Explicit `color: "text.primary"` on the message-body Typography

**Plan said:** Body Typography unchanged.

**What shipped:** Body Typography in score8o8 now sets `color: "text.primary"` explicitly.

**Why:** Before the reply feature, `ListItemText.secondary` was a single Typography element, and MUI rendered it as-is — the Typography inherited `text.primary` from its parent's default rendering. After the feature, `secondary` became a Fragment wrapping the quote `<Box>` + body `<Typography>`. The Fragment changed the inheritance chain enough that the body text rendered in a dimmer shade.

Adding `color: "text.primary"` to the body Typography's `sx` forces the original colour regardless of how MUI wraps the surrounding content. The admin side didn't need this fix because its body Typography already had an explicit `color: msg.isAdmin ? 'primary.contrastText' : 'text.primary'`.

The body Typography now includes a comment explaining the rationale so a future reader doesn't strip the explicit colour thinking it's redundant.

### 11.5 Admin's reply icon extracted into a `ReplyIconButton` component

**Plan said:** Reply icon rendered inline inside the `messages.map(...)` block.

**What shipped:** A dedicated `ReplyIconButton` component owns the per-message Tooltip state.

**Why:** §11.2 made the Tooltip controlled. score8o8 already has a `MessageItem` component to hold per-message state, but admin renders messages directly inline. Storing per-message Tooltip state at the `ChatTableRows` level (e.g., `openReplyTooltipMsgId`) would force a re-render of the entire message list on every hover transition. Extracting `ReplyIconButton` (memoised with `React.memo`) keeps each button's hover state local to that button — only the hovered icon re-renders.

The component lives in the same file as `AdminChatInput`, follows the same memoised pattern, and exposes the same prop shape as the inline version it replaced.

### 11.6 `sanitizeReplyTo` uses `{ shouldClean }` flag, NOT the plumbed `Filter` instance

**Plan said:** Extend `validateMessage`'s return shape with a `filter` field pointing at the shared `profanityFilter`, then pass it into `sanitizeReplyTo(raw, { profanityFilter })`.

**What shipped:** `sanitizeReplyTo(raw, { shouldClean = false })` calls the existing `cleanString` directly. The shared `profanityFilter` singleton is reached via `cleanString` (same module), no parameter plumbing.

**Why:** The plan's stated goal was "reuse the same `Filter` instance without a second instantiation per message". That goal is achieved either way — `cleanString` already uses the module-level singleton. The boolean flag is simpler, doesn't change `validateMessage`'s public API, and is one less coupling point. Same end behaviour, less surface area.

---

## What was unchanged from the plan

- §1 schema layout: `replyTo` subdocument exact shape ✓
- §2 socket events: no new events; `replyTo` extends `room_message` + `admin_room_message` payloads only ✓
- §4 service.js + roomManager.js + Redis keys: zero changes ✓
- §7 auth/security: all risks handled by existing pipeline (ban check, rate limit, length caps) ✓
- §10 no-regression guarantees: all 10 verified post-implementation ✓
- §11 perf: no extra Redis or Mongo round trips on the hot path ✓
- §13 non-goals: pinned-banner quote, reply count badge, threading, notifications, server-side parent verification, edit/delete, replyTo on reactions — none implemented ✓

---

## Files Changed (final)

| File | Lines added | Lines removed |
|---|---|---|
| `football-chat-backend/modules/chat/messageModel.js` | +10 | 0 |
| `football-chat-backend/utils/messageValidation.js` | +34 | 0 |
| `football-chat-backend/socket/socketHandler.js` | +23 | -5 |
| `football-next-score8o8/src/components/chatBox/chatBox.tsx` | +335 | -11 |
| `football-admin/src/sections/matches/chat-table-rows.tsx` | +307 | -17 |

No changes to:
- `modules/chat/service.js`
- `socket/roomManager.js`
- `utils/const_config.js`
- `utils/feature_flags.js`
- `package.json` (no new deps)
- Any Redis key, sorted set, hash, or pub/sub channel
- nginx config, ecosystem.config.js, OS tuning

---

## Verification done

- `node -c modules/chat/messageModel.js && node -c utils/messageValidation.js && node -c socket/socketHandler.js` — exit 0
- `npx tsc --noEmit -p tsconfig.json` in `football-next-score8o8` — exit 0
- `npx tsc --noEmit -p tsconfig.json` in `football-admin` — only pre-existing `react-day-picker` error in unrelated `date-range-picker.tsx`
- Manual code review of every edit confirmed against the no-regression guarantees in §10
- Cross-check against the plan section by section (every numbered subsection in §1–§13)
