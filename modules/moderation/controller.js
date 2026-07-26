// modules/moderation/controller.js
//
// Admin-facing read endpoints for the AI moderation audit log. Toggling the
// feature itself uses the existing generic /set-feature-flag endpoint
// (feature name "aimod") — nothing moderation-specific needed there.

const { sendResponse, sendError } = require("@project/utils");
const { pubClient: redis } = require("@project/config/redis");
const { BANNED_USERS_KEY } = require("@project/utils/const_config");
const racismPolicy = require("@project/utils/racism_policy");
const reporterConfig = require("@project/utils/aimod_reporter_config");
const ModerationLog = require("./model");
const { applyAdminBan } = require("./service");

const MAX_LOGS_LIMIT = 500;

// GET /get-moderation-logs?page=0&limit=25&action=BANNED&roomId=<id>
// Paginated, mirroring the apiCallStats convention (0-indexed page, skip =
// page*limit, response { rows→logs, total, page, limit }). The compound
// { <filter>, createdAt:-1 } indexes on ModerationLog serve filter+sort+skip
// in a single scan.
async function getModerationLogsController(req, res) {
  try {
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 25, 1),
      MAX_LOGS_LIMIT,
    );
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const skip = page * limit;

    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.roomId) filter.roomId = req.query.roomId;
    if (req.query.reportedUser) filter.reportedUser = req.query.reportedUser;

    const [logs, total] = await Promise.all([
      ModerationLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ModerationLog.countDocuments(filter),
    ]);

    // Enrich each row with the reported user's CURRENT ban status from Redis
    // (the source of truth). The log's `action` is historical — a user banned
    // then unbanned still has a BANNED row — so the admin UI must key its
    // Ban/Unban toggle off this live flag, not the stored action. One pipeline
    // of sIsMember over the distinct names on this page.
    const names = [
      ...new Set(logs.map((l) => l.reportedUser).filter(Boolean)),
    ];
    if (names.length > 0) {
      const pipeline = redis.multi();
      names.forEach((n) => pipeline.sIsMember(BANNED_USERS_KEY, n));
      const results = await pipeline.exec();
      const bannedByName = {};
      names.forEach((n, i) => {
        bannedByName[n] = !!results[i];
      });
      logs.forEach((l) => {
        l.reportedUserBanned = l.reportedUser
          ? !!bannedByName[l.reportedUser]
          : false;
      });
    }

    sendResponse(
      res,
      { logs, total, page, limit },
      "Moderation logs retrieved successfully",
      200,
    );
  } catch (error) {
    console.error("getModerationLogs error:", error.message);
    sendError(res, "Internal server error", 500);
  }
}

// GET /get-moderation-stats — action counts for the last 24h and 7d
async function getModerationStatsController(req, res) {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [day, week] = await Promise.all([
      ModerationLog.aggregate([
        { $match: { createdAt: { $gte: dayAgo } } },
        { $group: { _id: "$action", count: { $sum: 1 } } },
      ]),
      ModerationLog.aggregate([
        { $match: { createdAt: { $gte: weekAgo } } },
        { $group: { _id: "$action", count: { $sum: 1 } } },
      ]),
    ]);

    const toMap = (rows) =>
      rows.reduce((acc, r) => {
        acc[r._id] = r.count;
        return acc;
      }, {});

    sendResponse(
      res,
      { last24h: toMap(day), last7d: toMap(week) },
      "Moderation stats retrieved successfully",
      200,
    );
  } catch (error) {
    console.error("getModerationStats error:", error.message);
    sendError(res, "Internal server error", 500);
  }
}

// POST /set-user-ban  { name, isBanned, roomId? }
// Admin ban/unban from the logs dialog — real-time (broadcasts user_updated so
// a connected user locks/unlocks without a refresh) + posts an announcement
// into roomId. Mirrors the chat-panel popover, executed server-side.
async function setUserBanController(req, res) {
  try {
    const { name, isBanned, roomId } = req.body || {};
    if (!name || typeof name !== "string") {
      return sendError(res, "Missing 'name'", 400);
    }
    if (typeof isBanned !== "boolean") {
      return sendError(res, "'isBanned' must be a boolean", 400);
    }
    await applyAdminBan({ name, isBanned, roomId });
    return sendResponse(
      res,
      { name, isBanned },
      `User ${isBanned ? "banned" : "unbanned"} successfully`,
      200,
    );
  } catch (error) {
    console.error("setUserBan error:", error.message);
    return sendError(res, "Internal server error", 500);
  }
}

// GET /get-racism-mode → { mode, options }
async function getRacismModeController(req, res) {
  try {
    return sendResponse(
      res,
      { mode: racismPolicy.getMode(), options: racismPolicy.VALID },
      "Racism mode retrieved successfully",
      200,
    );
  } catch (error) {
    console.error("getRacismMode error:", error.message);
    return sendError(res, "Internal server error", 500);
  }
}

// POST /set-racism-mode { mode: "strict" | "moderate" | "minimal" }
// Cluster-synced (Redis persist + pub/sub) — every instance picks it up.
async function setRacismModeController(req, res) {
  try {
    const { mode } = req.body || {};
    if (!racismPolicy.VALID.includes(mode)) {
      return sendError(
        res,
        `'mode' must be one of: ${racismPolicy.VALID.join(", ")}`,
        400,
      );
    }
    const applied = await racismPolicy.setMode(mode);
    return sendResponse(res, { mode: applied }, "Racism mode updated", 200);
  } catch (error) {
    console.error("setRacismMode error:", error.message);
    return sendError(res, "Internal server error", 500);
  }
}

// GET /get-reporter-config → { config: { maxReports, windowSeconds }, bounds }
async function getReporterConfigController(req, res) {
  try {
    return sendResponse(
      res,
      {
        config: reporterConfig.getConfig(),
        bounds: {
          maxReports: reporterConfig.MAX_REPORTS_BOUND,
          windowSeconds: reporterConfig.WINDOW_BOUND,
        },
      },
      "Reporter config retrieved successfully",
      200,
    );
  } catch (error) {
    console.error("getReporterConfig error:", error.message);
    return sendError(res, "Internal server error", 500);
  }
}

// POST /set-reporter-config { maxReports?, windowSeconds? }
// Cluster-synced (Redis persist + pub/sub) — every instance picks it up. Values
// are clamped server-side by aimod_reporter_config.normalize(), so an
// out-of-range or malformed input can never persist a bad limit.
async function setReporterConfigController(req, res) {
  try {
    const { maxReports, windowSeconds } = req.body || {};
    if (maxReports === undefined && windowSeconds === undefined) {
      return sendError(res, "Provide 'maxReports' and/or 'windowSeconds'", 400);
    }
    const applied = await reporterConfig.setConfig({ maxReports, windowSeconds });
    return sendResponse(res, { config: applied }, "Reporter config updated", 200);
  } catch (error) {
    console.error("setReporterConfig error:", error.message);
    return sendError(res, "Internal server error", 500);
  }
}

module.exports = {
  getModerationLogsController,
  getModerationStatsController,
  setUserBanController,
  getRacismModeController,
  setRacismModeController,
  getReporterConfigController,
  setReporterConfigController,
};
