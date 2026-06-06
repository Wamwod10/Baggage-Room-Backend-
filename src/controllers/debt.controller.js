const debtService = require("../services/debt.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await debtService.listDebts(req.user, req.query)));
const close = asyncHandler(async (req, res) => success(res, await debtService.closeDebt(req.user, req.params.id, req.body)));

module.exports = { list, close };
