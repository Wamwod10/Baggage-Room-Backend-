const cashMovementService = require("../services/cashMovement.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await cashMovementService.listCashMovements(req.user, req.query)));

module.exports = { list };
