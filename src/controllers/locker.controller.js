const lockerService = require("../services/locker.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await lockerService.listLockers(req.user, req.query)));
const get = asyncHandler(async (req, res) => success(res, await lockerService.getLocker(req.user, req.params.id)));
const service = asyncHandler(async (req, res) => success(res, await lockerService.setService(req.user, req.params.id, req.body)));
const restore = asyncHandler(async (req, res) => success(res, await lockerService.restore(req.user, req.params.id)));
const transfer = asyncHandler(async (req, res) => success(res, await lockerService.transfer(req.user, req.body)));

module.exports = { list, get, service, restore, transfer };
