const notificationService = require("../services/notification.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await notificationService.listNotifications(req.user, req.query)));
const readOne = asyncHandler(async (req, res) => success(res, await notificationService.markRead(req.user, req.params.id)));
const readAll = asyncHandler(async (req, res) => success(res, await notificationService.markAllRead(req.user, req.body || {})));

module.exports = { list, readOne, readAll };
