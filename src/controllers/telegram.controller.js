const settingsService = require("../services/telegramSettings.service");
const { success, asyncHandler } = require("../utils/response");

const settings = asyncHandler(async (req, res) => success(res, await settingsService.listSettings(req.user, req.query)));
const update = asyncHandler(async (req, res) => success(res, await settingsService.updateSettings(req.user, req.params.branchId, req.body)));
const test = asyncHandler(async (req, res) => success(res, await settingsService.testSend(req.user, req.params.branchId)));

module.exports = { settings, update, test };
