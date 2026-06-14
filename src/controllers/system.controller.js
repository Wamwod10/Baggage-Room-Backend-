const systemService = require("../services/system.service");
const { success, asyncHandler } = require("../utils/response");

const resetData = asyncHandler(async (req, res) => {
  return success(res, await systemService.resetData(req.user, req.body));
});

module.exports = { resetData };
