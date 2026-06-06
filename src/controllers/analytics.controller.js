const analyticsService = require("../services/analytics.service");
const { success, asyncHandler } = require("../utils/response");

const dashboard = asyncHandler(async (req, res) => success(res, await analyticsService.dashboard(req.user, req.query)));
const reports = asyncHandler(async (req, res) => success(res, await analyticsService.reports(req.user, req.query)));

module.exports = { dashboard, reports };
