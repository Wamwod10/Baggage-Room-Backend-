const branchService = require("../services/branch.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => {
  const data = await branchService.listBranches(req.user);
  return success(res, data);
});

module.exports = { list };
