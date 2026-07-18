// Server-side mirror of football-next-score8o8/src/utils/messageValidation.ts +
// checkUrls.ts + checkOffensiveWords.ts. Runs inside the room_message handler
// to catch bots that connect directly to socket.io and skip the React
// validators, AND ensures consistent profanity censoring regardless of client.

// bad-words v3 is the last CommonJS release and exports the Filter class as
// the default export (not a named export). v4+ is ESM-only and would crash
// with ERR_REQUIRE_ESM under this CJS project. The FE uses v4 (Next.js
// handles ESM transparently); the runtime API of `clean()` and `isProfane()`
// is identical across both versions, so server/client behaviour matches.
const Filter = require("bad-words");

// Single shared Filter instance — Filter() is mildly expensive to construct
// (it loads the wordlist into memory) and is stateless across calls.
const profanityFilter = new Filter();

const MAX_LENGTH = 200;

const LEET_MAP = {
  4: "a",
  "@": "a",
  3: "e",
  1: "i",
  "|": "i",
  0: "o",
  5: "s",
  $: "s",
  7: "t",
};

function normalizeLeetspeak(text) {
  return text
    .split("")
    .map((char) => LEET_MAP[char] ?? char)
    .join("");
}

function checkBotSuffix(text) {
  return /\s[A-Z0-9]{2,4}$/.test(text.trim());
}

function checkAllCaps(text) {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 15) return false;
  const upperCount = (text.match(/[A-Z]/g) || []).length;
  return upperCount / letters.length > 0.7;
}

function checkExcessivePunctuation(text) {
  if (text.length < 10) return false;
  const specialCount = (text.match(/[^a-zA-Z0-9\s]/g) || []).length;
  return specialCount / text.length > 0.3;
}

function checkRepeatedPhrase(text) {
  const clean = text.toLowerCase().replace(/\s+/g, " ");
  const minLen = 15;
  if (clean.length < minLen * 2) return false;

  const noSpaces = clean.replace(/\s/g, "");
  if (noSpaces.length > 0 && new Set(noSpaces).size / noSpaces.length < 0.4)
    return true;

  const seen = new Set();
  for (let i = 0; i <= clean.length - minLen; i++) {
    const sub = clean.substring(i, i + minLen);
    if (seen.has(sub)) return true;
    seen.add(sub);
  }
  return false;
}

function jaccardSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  const aArr = Array.from(setA);
  const intersection = aArr.filter((x) => setB.has(x)).length;
  const union = new Set(aArr.concat(Array.from(setB))).size;
  return intersection / union;
}

function checkFuzzyDuplicate(text, recentMessages) {
  return recentMessages.some((prev) => jaccardSimilarity(text, prev) > 0.8);
}

// URL detection — broad match on http(s)://, www., and bare domains with
// common TLDs. Inlined instead of pulling url-regex-safe to avoid adding a
// dep on top of node's built-ins.
const URL_REGEX =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(com|net|org|io|co|gg|tv|me|info|biz|xyz|ru|cn|in|pk|uk|de)(\/[^\s]*)?\b)/i;

function containsUrls(text) {
  const cleaned = (text || "").trim().replace(/\s+/g, "");
  return URL_REGEX.test(cleaned);
}

// Censor profanity by replacing letters with "*". Mirrors the FE
// cleanString(inputValue) call site — a legitimate browser sends already
// cleaned content, but bots that bypass the React layer don't, so the server
// must clean before broadcast for consistent behavior.
function cleanString(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  try {
    return profanityFilter.clean(text);
  } catch {
    // bad-words throws on certain unicode edge cases — fall back to the raw
    // string rather than dropping the message because of a library quirk.
    return text;
  }
}

function isProfane(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  try {
    return profanityFilter.isProfane(text);
  } catch {
    return false;
  }
}

/**
 * Run all validators against a candidate message. Returns:
 *   { ok: true,  normalized, cleaned }   → broadcast `cleaned` (censored)
 *   { ok: false, reason }                → drop silently + record strike
 *
 * `recentMessages` is the per-socket ring buffer of normalized messages.
 * `cleaned` is the input with profanity replaced by asterisks — caller
 * should broadcast and persist this, NOT the raw content.
 */
function validateMessage(content, recentMessages = []) {
  if (typeof content !== "string") {
    return { ok: false, reason: "invalid_type" };
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_LENGTH) return { ok: false, reason: "too_long" };

  if (containsUrls(content)) return { ok: false, reason: "url" };

  const leetNormalized = normalizeLeetspeak(content);
  const normalized = leetNormalized
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "");

  const words = normalized.split(" ");
  const hasRepeatingWords = words.some((w, i) => w && w === words[i + 1]);

  if (checkBotSuffix(content)) return { ok: false, reason: "bot_suffix" };
  if (checkAllCaps(content)) return { ok: false, reason: "all_caps" };
  if (checkExcessivePunctuation(content))
    return { ok: false, reason: "excessive_punctuation" };
  if (checkRepeatedPhrase(leetNormalized))
    return { ok: false, reason: "repeated_phrase" };
  if (/([a-zA-Z0-9])\1{4,}/.test(normalized))
    return { ok: false, reason: "repeated_char" };
  if (hasRepeatingWords) return { ok: false, reason: "repeated_word" };
  if (checkFuzzyDuplicate(normalized, recentMessages))
    return { ok: false, reason: "fuzzy_duplicate" };

  return { ok: true, normalized, cleaned: cleanString(content) };
}

// Reply quote sanitiser. Called on every room_message / admin_room_message
// payload (cost ~50 ns when replyTo is absent — the first guard returns null
// immediately). Never touches Redis or Mongo — bounding lengths and types is
// sufficient because the snapshot is display-only metadata; the surrounding
// message still goes through ban + rate-limit + content validation, and a
// bot impersonating an admin in the quote header gains no new attack
// surface (they could already write "Admin: …" in their message body).
const REPLY_SNIPPET_MAX = 140;
const REPLY_SENDER_MAX = 50;
const OBJECT_ID_REGEX = /^[a-f0-9]{24}$/i;

function sanitizeReplyTo(raw, { shouldClean = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const { messageId, senderName, contentSnippet, isAdmin } = raw;

  if (typeof messageId !== "string" || !OBJECT_ID_REGEX.test(messageId)) {
    return null;
  }
  if (typeof senderName !== "string" || senderName.length === 0) return null;
  if (typeof contentSnippet !== "string" || contentSnippet.length === 0)
    return null;

  let snippet = contentSnippet.slice(0, REPLY_SNIPPET_MAX);
  if (shouldClean) snippet = cleanString(snippet);

  return {
    messageId,
    senderName: senderName.slice(0, REPLY_SENDER_MAX),
    contentSnippet: snippet,
    isAdmin: !!isAdmin,
  };
}

module.exports = {
  MAX_LENGTH,
  OBJECT_ID_REGEX,
  validateMessage,
  cleanString,
  isProfane,
  sanitizeReplyTo,
  // Exported for unit testing if needed
  normalizeLeetspeak,
  checkBotSuffix,
  checkAllCaps,
  checkExcessivePunctuation,
  checkRepeatedPhrase,
  checkFuzzyDuplicate,
  containsUrls,
};
