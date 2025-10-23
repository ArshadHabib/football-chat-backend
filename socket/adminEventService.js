const { emitToAdmins, emitToAdmin } = require("./roomManager");

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

// Send match events (specific to your use case)
const sendMatchEvents = (eventsData) => {
  return emitToAdmins("match_events", {
    title: "Match Events Update",
    data: eventsData,
    priority: "medium",
  });
};

// Send real-time analytics
const sendAnalytics = (analyticsData) => {
  return emitToAdmins("analytics_update", {
    title: "Analytics Update",
    data: analyticsData,
    priority: "low",
  });
};

// Send server health status
const sendServerHealth = (healthData) => {
  return emitToAdmins("server_health", {
    title: "Server Health Status",
    data: healthData,
    priority: healthData.status === "critical" ? "high" : "medium",
  });
};

// Batch send multiple events
const sendBatchEvents = (events) => {
  let sentCount = 0;
  events.forEach((event) => {
    const result = emitToAdmins(event.type, event.data);
    if (result > 0) sentCount++;
  });
  return sentCount;
};

// Get connected admin count (if you expose this from roomManager)
const getConnectedAdminCount = () => {
  // Note: You'll need to expose this from roomManager or use a different approach
  console.log(
    "Note: getConnectedAdminCount requires implementation in roomManager"
  );
  return 0;
};

// Utility function to format match data for admin
const formatMatchData = (matches) => {
  return {
    matches: Array.isArray(matches) ? matches : [matches],
    lastUpdated: new Date().toISOString(),
    total: Array.isArray(matches) ? matches.length : 1,
  };
};

// Compose multiple notification types
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
