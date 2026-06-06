const inkassaService = require("../services/inkassa.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await inkassaService.listInkassa(req.user, req.query)));
const create = asyncHandler(async (req, res) => success(res, await inkassaService.createInkassa(req.user, req.body), 201));

module.exports = { list, create };
