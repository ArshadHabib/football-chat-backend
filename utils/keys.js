const crypto = require("crypto");

const digest = (value) => crypto.createHash("sha256").update(value).digest();

// True when `value` is the key from .env. Compares SHA-256 digests with
// timingSafeEqual (always 32 bytes, so timing reveals neither the key nor its
// length). An unset key, or anything but a non-empty string, never matches.
const keyMatches = (value, key) => {
  if (typeof value !== "string" || !value) return false;
  if (typeof key !== "string" || !key.trim()) return false;
  return crypto.timingSafeEqual(digest(value), digest(key.trim()));
};

module.exports = { keyMatches };
