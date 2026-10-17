const { MINUTES_BEFORE_MATCH_TO_SCRAP } = require("./const_config");

const ROLES = {
  ADMIN: "admin",
  USER: "user",
};

const sendResponse = (res, data, message = null, status = 200) => {
  res.status(status).json({
    data,
    status,
    message: message,
  });
};

const sendError = (res, message, status = 500) => {
  res.status(status).json({
    data: null,
    status,
    message,
  });
};

function handleMatchStatus({ isLive, isEnded, matchDate }) {
  // Get current UTC time in milliseconds (currentDate is already in UTC)
  const currentDate = Date.now(); // This gives the current UTC time in milliseconds

  // If the match is ended, return false (isEnded true and isLive false)
  if (isEnded) {
    return { isEnded: true, isLive: false };
  }

  // If the match is live, return true (isLive true and isEnded false)
  if (isLive) {
    return { isLive: true, isEnded: false };
  }

  // Convert matchDate to UTC using Date constructor
  const matchTime = new Date(matchDate); // matchDate is in ISO 8601 format, already in UTC

  // If matchDate is not valid, return isEnded true, isLive false
  if (isNaN(matchTime)) {
    return { isEnded: true, isLive: false };
  }

  // Calculate the time difference between the current UTC time and the match date
  const timeDifferenceInMinutes =
    (matchTime.getTime() - currentDate) / (1000 * 60); // Convert ms to minutes

  // If the match date is less than MINUTES_BEFORE_MATCH_TO_SCRAP minutes from the current time, return live status
  if (timeDifferenceInMinutes < MINUTES_BEFORE_MATCH_TO_SCRAP) {
    return { isLive: false, isEnded: false, isLessThan50: true };
  }

  // If the match date is more than MINUTES_BEFORE_MATCH_TO_SCRAP minutes ago, subtract MINUTES_BEFORE_MATCH_TO_SCRAP minutes from the match time
  matchTime.setMinutes(matchTime.getMinutes() - MINUTES_BEFORE_MATCH_TO_SCRAP);

  return {
    isLive: false,
    isEnded: false,
    scrapDate: matchTime.toISOString(), // Return the updated match date minus 50 minutes in UTC
  };
}

// Client-supplied room ids, names and keys go straight into Redis commands,
// and node-redis rejects any argument that isn't a string (or Buffer). Socket
// handlers don't catch that, and Node exits on an unhandled rejection, so one
// bad payload would stop the whole server. Socket handlers and routes check
// their input with these first.
const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

// A socket event's payload, or {} when the client sent none (or not an
// object), so destructuring it can't throw.
const asPayload = (data) => (data && typeof data === "object" ? data : {});

module.exports = {
  ROLES,
  sendResponse,
  sendError,
  handleMatchStatus,
  isNonEmptyString,
  asPayload,
};
