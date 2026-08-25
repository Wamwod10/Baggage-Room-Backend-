const orderService = require("../services/order.service");
const { success, asyncHandler } = require("../utils/response");
const { createTimer } = require("../utils/perf");

const timed = async (scope, meta, fn) => {
  const timer = createTimer(scope, meta);
  try {
    const data = await timer.time("service", fn);
    timer.end({ ok: true });
    return data;
  } catch (error) {
    timer.end({ ok: false, statusCode: error.statusCode || 500 });
    throw error;
  }
};

const list = asyncHandler(async (req, res) => success(res, await orderService.listOrders(req.user, req.query)));
const get = asyncHandler(async (req, res) => success(res, await orderService.getOrder(req.user, req.params.id)));
const create = asyncHandler(async (req, res) => success(res, await timed(
  "orders.create.endpoint",
  {
    method: req.method,
    path: req.route?.path || "/",
    hasIdempotencyKey: Boolean(req.get("Idempotency-Key")),
  },
  () => orderService.createOrder(req.user, req.body, {
    idempotencyKey: req.get("Idempotency-Key"),
  }),
), 201));
const update = asyncHandler(async (req, res) => success(res, await orderService.updateOrder(req.user, req.params.id, req.body, { idempotencyKey: req.get("Idempotency-Key") })));
const pickup = asyncHandler(async (req, res) => success(res, await timed(
  "orders.pickup.endpoint",
  {
    method: req.method,
    path: "/:id/pickup",
    hasOvertime: Number(req.body?.overtimeAmount || req.body?.extraPayment || 0) > 0,
    hasDebtPayment: req.body?.debtPaidAmount !== undefined,
  },
  () => orderService.pickupOrder(req.user, req.params.id, req.body, { idempotencyKey: req.get("Idempotency-Key") }),
)));
const cancel = asyncHandler(async (req, res) => success(res, await orderService.cancelOrder(req.user, req.params.id, req.body, { idempotencyKey: req.get("Idempotency-Key") })));
const sendTelegram = asyncHandler(async (req, res) => success(res, await orderService.sendOrderTelegram(req.user, req.params.id)));

module.exports = { list, get, create, update, pickup, cancel, sendTelegram };
