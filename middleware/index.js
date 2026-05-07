const axios = require("axios");
const { ROLES, sendError } = require("@project/utils");
const { ENDPOINTS } = require("@project/utils/endpoints");
const { ADMIN_KEY } = require("@project/utils/const_config");

// Common authentication logic
const authenticateToken = async (token) => {
  if (!token) {
    throw new Error("No token provided");
  }

  const authResponse = await axios.get(ENDPOINTS.auth.me, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const user = authResponse.data.data.user;
  if (!user) {
    throw new Error("User not found in response");
  }

  return {
    userIdFromToken: user.userIdFromToken,
    userRoleFromToken: user.userRoleFromToken,
    user,
  };
};

// Main authentication middleware
const isUserLoggedIn = async (req, res, next) => {
  try {
    const token = req?.headers?.authorization?.split(" ")?.[1];
    const userData = await authenticateToken(token);

    req.body.userIdFromToken = userData.userIdFromToken;
    req.body.userRoleFromToken = userData.userRoleFromToken;

    next();
  } catch (error) {
    console.error("Auth server error:", error.message);

    if (error.message === "No token provided") {
      return sendError(res, "No token provided", 401);
    }

    if (error.response?.status === 401) {
      return sendError(res, "Unauthorized", 401);
    }

    return sendError(res, "Authentication service unavailable", 503);
  }
};

// Main authentication middleware
const isAdminKeyCorrect = async (req, res, next) => {
  try {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) {
      return sendError(res, "Admin Key is incorrect", 401);
    }
    next();
  } catch (error) {
    return sendError(res, "Error in authenticating admin key", 503);
  }
};

// Role checking middleware
const checkRole = (allowedRole) => {
  return async (req, res, next) => {
    try {
      const token = req?.headers?.authorization?.split(" ")?.[1];
      const userData = await authenticateToken(token);

      req.body.userIdFromToken = userData.userIdFromToken;
      req.body.userRoleFromToken = userData.userRoleFromToken;

      // Check if user has the required role
      if (userData.userRoleFromToken !== allowedRole) {
        return sendError(res, "Insufficient permissions", 403);
      }

      next();
    } catch (error) {
      console.error("Auth server error:", error.message);

      if (error.message === "No token provided") {
        return sendError(res, "No token provided", 401);
      }

      if (error.response?.status === 401) {
        return sendError(res, "Unauthorized", 401);
      }

      return sendError(res, "Authentication service unavailable", 503);
    }
  };
};

const attachClientIp = (req, res, next) => {
  try {
    // // Express handles proxy correctly because of `trust proxy`
    // let ip =
    //   req.ip ||
    //   req.headers["x-forwarded-for"]?.split(",")?.[0]?.trim() ||
    //   req.headers["x-real-ip"] ||
    //   req.socket.remoteAddress;

    // // Normalize IPv6 localhost / mapped IPv4
    // if (ip === "::1") ip = "127.0.0.1";
    // if (ip?.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");

    // // Attach safely
    // req.clientIp = ip;
    // req.body.clientIp = ip;
    // console.log("Client IP: ", ip);

    // next();
    let ip = req.ip;

    // if (ip === "::1") ip = "127.0.0.1";
    if (ip === "::1") ip = "";
    if (ip?.startsWith("::ffff:")) ip = ip.replace("::ffff:", "");
    if (ip === "127.0.0.1") ip = "";

    req.clientIp = ip;
    req.body.clientIp = ip;

    next();
  } catch (error) {
    console.error("IP middleware error:", error);
    next(); // never block request because of IP
  }
};

module.exports = {
  isAdmin: checkRole(ROLES.ADMIN),
  isUser: checkRole(ROLES.USER),
  isUserLoggedIn,
  // Export for reuse in other modules if needed
  authenticateToken,
  isAdminKeyCorrect,
  attachClientIp,
};
