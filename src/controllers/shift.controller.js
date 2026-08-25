const shiftService = require("../services/shift.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await shiftService.listShifts(req.user, req.query)));
const current = asyncHandler(async (req, res) => success(res, await shiftService.currentShift(req.user, req.query)));
const sendCurrentSalesTelegram = asyncHandler(async (req, res) => success(res, await shiftService.sendCurrentSalesTelegram(req.user, req.query)));
const open = asyncHandler(async (req, res) => success(res, await shiftService.openShift(req.user, req.body, { idempotencyKey: req.get("Idempotency-Key") }), 201));
const close = asyncHandler(async (req, res) => success(res, await shiftService.closeShift(req.user, req.params.id, req.body, { idempotencyKey: req.get("Idempotency-Key") })));

module.exports = { list, current, sendCurrentSalesTelegram, open, close };
