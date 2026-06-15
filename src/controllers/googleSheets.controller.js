const googleSheetsService = require("../services/googleSheets.service");
const { success, asyncHandler } = require("../utils/response");

const test = asyncHandler(async (req, res) => {
  return success(res, await googleSheetsService.sendTestEvent(req.user, req.body), 201);
});

module.exports = { test };
