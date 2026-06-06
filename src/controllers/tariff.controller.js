const tariffService = require("../services/tariff.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await tariffService.listTariffs(req.user, req.query)));
const update = asyncHandler(async (req, res) => success(res, await tariffService.updateTariff(req.user, req.params.id, req.body)));

module.exports = { list, update };
