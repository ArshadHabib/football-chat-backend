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

module.exports = {
  ROLES,
  sendResponse,
  sendError,
};
