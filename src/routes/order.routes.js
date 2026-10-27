const router = require("express").Router();
const { z, idParam, amount, currency, paymentType, phone, orderStatus, lockerSize } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const orderController = require("../controllers/order.controller");
const orderArrayLimits = { bodyArrayLimits: { items: 1000, lockerIds: 1000 } };

const orderItem = z.object({
  lockerId: z.string().min(1),
  size: lockerSize.optional(),
  count: z.coerce.number().int().positive().optional(),
  tariffHours: z.coerce.number().int().positive().optional(),
  originalPrice: amount.optional(),
  discountAmount: amount.optional(),
  currency: currency.optional(),
});
router.get('/financial-capabilities', (req, res) => {
  let canAdjustPrice = false;
  try { require('../services/financialControls').assertPricePermission(req.user, 'Capability check'); canAdjustPrice = true; } catch { /* Fail closed. */ }
  return require('../utils/response').success(res, { canAdjustPrice });
});
router.post('/quote', validate(z.object({ body: z.object({
  branchId: z.string().min(1), hours: z.number().positive(), isCustom: z.boolean().optional(), currency,
  exchangeRate: z.number().positive().optional(), items: z.array(z.object({ size: lockerSize, count: z.number().int().positive() })).min(1),
}) }), orderArrayLimits), require('../utils/response').asyncHandler(async (req, res) => require('../utils/response').success(res,
  await require('../services/pricing.service').quote(req.user, req.body))));
router.get('/:id/pickup-quote', require('../utils/response').asyncHandler(async (req, res) => require('../utils/response').success(res,
  await require('../services/pricing.service').pickupQuote(req.user, req.params.id))));
router.post('/:id/payments', validate(z.object({ body: z.object({ amount, currency, paymentType }) })),
  require('../utils/response').asyncHandler(async (req, res) => require('../utils/response').success(res,
    await require('../services/orderPayment.service').pay(req.user, req.params.id, req.body, req.get('Idempotency-Key')))));

router.get(
  "/",
  validate(z.object({
    query: z.object({
      branchId: z.string().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      status: orderStatus.optional(),
      statuses: z.string().optional(),
      paymentType: paymentType.optional(),
      currency: currency.optional(),
      search: z.string().optional(),
      phone: z.string().optional(),
      passport: z.string().optional(),
      active: z.string().optional(),
      debtOnly: z.string().optional(),
      sortBy: z.enum(["createdAt", "updatedAt", "checkIn", "plannedCheckOut", "orderNumber", "status", "paymentType", "finalAmount", "realPaidAmount"]).optional(),
      sortOrder: z.enum(["asc", "desc"]).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  })),
  orderController.list
);
router.get("/:id", validate(idParam), orderController.get);
router.post("/:id/telegram", validate(idParam), orderController.sendTelegram);
router.post(
  "/",
  validate(
    z.object({
      body: z.object({
        branchId: z.string().min(1, "branchId is required"),
        clientName: z.string().trim().min(2),
        phone,
        passport: z.string().optional(),
        tariffHours: z.coerce.number().int().positive(),
        customHours: z.coerce.number().int().positive().optional(),
        currency: currency.default("UZS"),
        paymentType,
        realPaidPaymentType: paymentType.optional(),
        paidPaymentType: paymentType.optional(),
        calculatedAmount: amount.optional(),
        discountAmount: amount.optional(),
        discountReason: z.string().optional(),
        finalAmount: amount.optional(),
        realPaidAmount: amount.optional(),
        realPaidReason: z.string().optional(),
        exchangeRate: z.coerce.number().positive().optional(),
        checkIn: z.string().datetime().optional(),
        plannedCheckOut: z.string().datetime().optional(),
        note: z.string().optional(),
        lockerIds: z.array(z.string().min(1)).optional(),
        items: z.array(orderItem).optional(),
      }).superRefine((body, ctx) => {
        const hasItems = Array.isArray(body.items) && body.items.length > 0;
        const hasLockerIds = Array.isArray(body.lockerIds) && body.lockerIds.length > 0;

        if (!hasItems && !hasLockerIds) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["items"],
            message: "items or lockerIds must contain at least one locker",
          });
        }
      }),
    }), orderArrayLimits
  ),
  orderController.create
);
router.patch(
  "/:id",
  validate(idParam.extend({
    body: z.object({
      clientName: z.string().min(2).optional(),
      phone: phone.optional(),
      passport: z.string().optional(),
      note: z.string().optional(),
      discountReason: z.string().optional(),
      priceChangeReason: z.string().trim().min(1).optional(),
      exchangeRate: z.coerce.number().positive().optional(),
      sourceExchangeRate: z.coerce.number().positive().optional(),
      paidPaymentType: paymentType.optional(),
      realPaidReason: z.string().optional(),
      checkOut: z.string().datetime().optional(),
      plannedCheckOut: z.string().datetime().optional(),
      paymentType: paymentType.optional(),
      currency: currency.optional(),
      finalAmount: amount.optional(),
      realPaidAmount: amount.optional(),
      overtimeAmount: amount.optional(),
      overtimePaymentType: paymentType.optional(),
      doplataPaymentType: paymentType.optional(),
      overtimeCurrency: currency.optional(),
      items: z.array(z.object({
        id: z.string().min(1).optional(),
        remove: z.boolean().optional(),
        lockerId: z.string().min(1).optional(),
        size: lockerSize.optional(),
        count: z.coerce.number().int().positive().optional(),
      })).optional(),
    }),
  }), orderArrayLimits),
  orderController.update
);
router.post(
  "/:id/pickup",
  validate(
    idParam.extend({
      body: z.object({
        realPickupTime: z.string().datetime().optional(),
        exchangeRate: z.coerce.number().positive().optional(),
        sourceExchangeRate: z.coerce.number().positive().optional(),
        realPaidAmount: amount.optional(),
        overtimeAmount: amount.optional(),
        extraPayment: amount.optional(),
        debtPaidAmount: amount.optional(),
        priceChangeReason: z.string().trim().min(1).optional(),
        quotedOvertimeAmount: amount.optional(),
        paymentType: paymentType.optional(),
        overtimePaymentType: paymentType.optional(),
        doplataPaymentType: paymentType.optional(),
        debtPaymentType: paymentType.optional(),
        currency: currency.optional(),
      }),
    })
  ),
  orderController.pickup
);
router.post("/:id/cancel", validate(idParam.extend({ body: z.object({ cancelReason: z.string().optional(), reason: z.string().optional() }) })), orderController.cancel);

module.exports = router;
