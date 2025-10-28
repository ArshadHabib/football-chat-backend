// socket/adminEventService.js
const { emitToAdmins, emitToAdmin } = require("./roomManager");

// Batch processing for multiple events
const eventQueue = [];
const BATCH_PROCESSING_INTERVAL = 100; // 100ms
let batchTimeout = null;

function processEventBatch() {
  if (eventQueue.length === 0) {
    batchTimeout = null;
    return;
  }

  const batch = eventQueue.splice(0, 50); // Process max 50 events at a time
  let sentCount = 0;

  batch.forEach(({ event, data }) => {
    const result = emitToAdmins(event.type, data);
    if (result > 0) sentCount++;
  });

  console.log(`Processed ${batch.length} events, sent ${sentCount}`);

  // Schedule next batch if there are more events
  if (eventQueue.length > 0) {
    batchTimeout = setTimeout(processEventBatch, BATCH_PROCESSING_INTERVAL);
  } else {
    batchTimeout = null;
  }
}

function queueEvent(event, data) {
  eventQueue.push({ event, data });

  if (!batchTimeout) {
    batchTimeout = setTimeout(processEventBatch, BATCH_PROCESSING_INTERVAL);
  }
}

// Send latest matches to all admins
const sendLatestMatches = (matchesData, lastUpdatedAdminId) => {
  return emitToAdmins("latest_matches", {
    title: "Latest Matches Update",
    data: matchesData,
    lastUpdatedAdminId,
    count: matchesData?.length || 0,
    priority: "high",
  });
};

// Send system alerts to all admins
const sendSystemAlert = (alertData) => {
  return emitToAdmins("system_alert", {
    title: "System Alert",
    data: alertData,
    priority: "high",
    requiresAction: true,
  });
};

// Send user statistics to all admins
const sendUserStats = (statsData) => {
  return emitToAdmins("user_statistics", {
    title: "User Statistics Update",
    data: statsData,
    priority: "low",
  });
};

// Send general notification to all admins
const sendNotification = (title, message, data = {}, priority = "medium") => {
  return emitToAdmins("general_notification", {
    title,
    message,
    data,
    priority,
  });
};

// Send data to specific admin
const sendToAdmin = (socketId, eventName, data) => {
  return emitToAdmin(socketId, eventName, data);
};

// Batch send multiple events (optimized)
const sendBatchEvents = (events) => {
  events.forEach((event) => {
    queueEvent(event, event.data);
  });
  return events.length;
};

// Rest of the functions remain the same but can use batching...
const sendMatchEvents = (eventsData) => {
  return emitToAdmins("match_events", {
    title: "Match Events Update",
    data: eventsData,
    priority: "medium",
  });
};

const sendAnalytics = (analyticsData) => {
  return emitToAdmins("analytics_update", {
    title: "Analytics Update",
    data: analyticsData,
    priority: "low",
  });
};

const sendServerHealth = (healthData) => {
  return emitToAdmins("server_health", {
    title: "Server Health Status",
    data: healthData,
    priority: healthData.status === "critical" ? "high" : "medium",
  });
};

const getConnectedAdminCount = () => {
  console.log(
    "Note: getConnectedAdminCount requires implementation in roomManager"
  );
  return 0;
};

const formatMatchData = (matches) => {
  return {
    matches: Array.isArray(matches) ? matches : [matches],
    lastUpdated: new Date().toISOString(),
    total: Array.isArray(matches) ? matches.length : 1,
  };
};

const composeMatchNotification = (match, eventType) => {
  const baseData = formatMatchData(match);

  switch (eventType) {
    case "match_created":
      return sendNotification(
        "New Match Created",
        `Match: ${match.team1} vs ${match.team2}`,
        baseData,
        "high"
      );
    case "match_updated":
      return sendNotification(
        "Match Updated",
        `Updated: ${match.team1} vs ${match.team2}`,
        baseData,
        "medium"
      );
    case "match_completed":
      return sendNotification(
        "Match Completed",
        `Completed: ${match.team1} ${match.score1} - ${match.score2} ${match.team2}`,
        baseData,
        "medium"
      );
    default:
      return sendLatestMatches(baseData);
  }
};

module.exports = {
  sendLatestMatches,
  sendSystemAlert,
  sendUserStats,
  sendNotification,
  sendToAdmin,
  sendMatchEvents,
  sendAnalytics,
  sendServerHealth,
  sendBatchEvents,
  getConnectedAdminCount,
  formatMatchData,
  composeMatchNotification,
};
