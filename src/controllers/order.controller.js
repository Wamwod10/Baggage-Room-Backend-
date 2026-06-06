const orderService = require("../services/order.service");
const { success, asyncHandler } = require("../utils/response");

const list = asyncHandler(async (req, res) => success(res, await orderService.listOrders(req.user, req.query)));
const get = asyncHandler(async (req, res) => success(res, await orderService.getOrder(req.user, req.params.id)));
const create = asyncHandler(async (req, res) => success(res, await orderService.createOrder(req.user, req.body), 201));
const update = asyncHandler(async (req, res) => success(res, await orderService.updateOrder(req.user, req.params.id, req.body)));
const pickup = asyncHandler(async (req, res) => success(res, await orderService.pickupOrder(req.user, req.params.id, req.body)));
const cancel = asyncHandler(async (req, res) => success(res, await orderService.cancelOrder(req.user, req.params.id, req.body)));

module.exports = { list, get, create, update, pickup, cancel };
