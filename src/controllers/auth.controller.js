const authService = require("../services/auth.service");
const { success, asyncHandler } = require("../utils/response");

const login = asyncHandler(async (req, res) => {
  const data = await authService.login(req.body);
  return success(res, data);
});

const me = asyncHandler(async (req, res) => {
  const data = await authService.me(req.user.id);
  return success(res, data);
});

module.exports = { login, me };
