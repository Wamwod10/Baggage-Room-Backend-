const router = require("express").Router();
const { z, idParam, amount, currency, paymentType, phone, orderStatus } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const orderController = require("../controllers/order.controller");

const orderItem = z.object({
  lockerId: z.string().min(1),
  tariffHours: z.coerce.number().int().positive().optional(),
  originalPrice: amount.optional(),
  discountAmount: amount.optional(),
  currency: currency.optional(),
});

router.get(
  "/",
  validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), status: orderStatus.optional(), paymentType: paymentType.optional(), currency: currency.optional(), search: z.string().optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(200).optional() }) })),
  orderController.list
);
router.get("/:id", validate(idParam), orderController.get);
router.post(
  "/",
  validate(
    z.object({
      body: z.object({
        branchId: z.string().optional(),
        clientName: z.string().trim().min(2),
        phone,
        passport: z.string().optional(),
        tariffHours: z.coerce.number().int().positive(),
        customHours: z.coerce.number().int().positive().optional(),
        currency: currency.default("UZS"),
        paymentType,
        calculatedAmount: amount.optional(),
        discountAmount: amount.optional(),
        discountReason: z.string().optional(),
        finalAmount: amount.optional(),
        realPaidAmount: amount.optional(),
        realPaidReason: z.string().optional(),
        checkIn: z.string().datetime().optional(),
        plannedCheckOut: z.string().datetime().optional(),
        note: z.string().optional(),
        lockerIds: z.array(z.string()).optional(),
        items: z.array(orderItem).optional(),
      }),
    })
  ),
  orderController.create
);
router.patch("/:id", validate(idParam.extend({ body: z.object({ clientName: z.string().min(2).optional(), phone: phone.optional(), passport: z.string().optional(), note: z.string().optional(), discountReason: z.string().optional(), realPaidReason: z.string().optional() }) })), orderController.update);
router.post(
  "/:id/pickup",
  validate(
    idParam.extend({
      body: z.object({
        realPickupTime: z.string().datetime().optional(),
        overtimeAmount: amount.optional(),
        debtPaidAmount: amount.optional(),
        paymentType: paymentType.optional(),
        currency: currency.optional(),
      }),
    })
  ),
  orderController.pickup
);
router.post("/:id/cancel", validate(idParam.extend({ body: z.object({ cancelReason: z.string().optional(), reason: z.string().optional() }) })), orderController.cancel);

module.exports = router;
