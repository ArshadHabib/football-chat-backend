const FIRST_SERVER_BASE_URL = "http://localhost:5007";

const ENDPOINTS = {
  auth: {
    me: `${FIRST_SERVER_BASE_URL}/api/next/user/auth-me`,
    register: `${FIRST_SERVER_BASE_URL}/api/next/user/signup`,
    login: `${FIRST_SERVER_BASE_URL}/api/next/user/admin/login`,
    update: `${FIRST_SERVER_BASE_URL}/api/next/user/update`,
    changePassword: `${FIRST_SERVER_BASE_URL}/api/next/user/change-password`,
  },
};

module.exports = {
  ENDPOINTS,
  FIRST_SERVER_BASE_URL,
};
