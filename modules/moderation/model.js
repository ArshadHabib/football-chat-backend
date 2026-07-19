// modules/moderation/model.js
//
// Audit log — one document per @admin report, whatever the outcome. This is
// the human paper trail behind every AI decision: admins review it in the
// panel, unban false positives via the existing update-user flow, and tune
// the confidence threshold from real data. Writes are fire-and-forget from
// service.js — logging must never block or fail moderation itself.

const mongoose = require("mongoose");

const moderationLogSchema = new mongoose.Schema(
  {
    roomId: { type: String },
    // Not indexed — never used as a query filter (controller filters on
    // action / roomId / reportedUser only); indexing it would just add
    // write amplification on the high-volume SKIPPED_* audit path.
    reportedMessageId: { type: String },
    reportedUser: { type: String },
    // Frozen evidence — what the offender actually wrote, fetched server-side
    reportedContent: { type: String, default: "" },
    reporterName: { type: String, default: "" },
    reporterIp: { type: String, default: "" },
    verdict: {
      violation: { type: Boolean },
      category: { type: String },
      confidence: { type: Number },
      reason: { type: String },
    },
    action: {
      type: String,
      enum: [
        "BANNED",
        "NEEDS_REVIEW",
        "DISMISSED",
        "ERROR",
        "SKIPPED_REPORTER_LIMIT",
        "SKIPPED_GLOBAL_BUDGET",
        "SKIPPED_NOT_FOUND",
        "SKIPPED_TARGET_ADMIN",
        "SKIPPED_SELF_REPORT",
        "SKIPPED_ALREADY_BANNED",
      ],
      index: true,
    },
    model: { type: String, default: "" }, // gemini model used (empty on skips)
    // Racism strictness active when this report was judged (strict/moderate/
    // minimal) — recorded per row so the audit shows which policy produced the
    // verdict. Absent on pre-feature rows.
    racismMode: { type: String, default: "" },
    latencyMs: { type: Number, default: 0 },
    error: { type: String, default: "" },
    // True when the verdict came from the 24h Redis cache instead of a live call
    fromCache: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Index shapes match the admin panel's queries (controller.js): the feed
// filters by one of action / roomId / reportedUser and always sorts by
// createdAt desc; the stats aggregation matches on createdAt only. Compound
// {filter, createdAt:-1} indexes serve filter+sort in a single scan as the
// audit collection grows, and the lone {createdAt:-1} covers the unfiltered
// feed + the stats $match. Same index count as separate single-field indexes,
// better read shape — write amplification on the high-volume SKIPPED_* path
// is unchanged.
moderationLogSchema.index({ createdAt: -1 });
moderationLogSchema.index({ action: 1, createdAt: -1 });
moderationLogSchema.index({ roomId: 1, createdAt: -1 });
moderationLogSchema.index({ reportedUser: 1, createdAt: -1 });

module.exports = mongoose.model("ModerationLog", moderationLogSchema);
