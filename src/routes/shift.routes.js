const router = require("express").Router();
const { z, idParam, amount } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const shiftController = require("../controllers/shift.controller");
const currencyAmountMap = z.record(z.enum(["UZS", "USD", "EUR", "RUB", "KZT", "TJS"]), amount);
const currencyMapLimits = { bodyObjectLimits: { openingCashByCurrency: 6, acceptedCashByCurrency: 6, closingCashByCurrency: 6 } };

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), status: z.enum(["OPEN", "CLOSED"]).optional(), limit: z.coerce.number().int().positive().max(100).optional() }) })), shiftController.list);
router.get("/current", validate(z.object({ query: z.object({ branchId: z.string().optional() }) })), shiftController.current);
router.get("/current/operator-stats", validate(z.object({ query: z.object({ branchId: z.string().optional() }) })), shiftController.operatorStats);
router.post("/current/sales-telegram", validate(z.object({ query: z.object({ branchId: z.string().optional() }) })), shiftController.sendCurrentSalesTelegram);
router.post(
  "/open",
  validate(z.object({ body: z.object({ branchId: z.string().optional(), openingCash: amount.default(0), acceptedCash: amount.default(0), openingCashByCurrency: currencyAmountMap.optional(), acceptedCashByCurrency: currencyAmountMap.optional(), acceptedFromName: z.string().optional(), acceptedByName: z.string().optional(), handoverToName: z.string().optional() }) }), currencyMapLimits),
  shiftController.open
);
router.post(
  "/:id/close",
  validate(idParam.extend({ body: z.object({ closingCash: amount.optional(), closingCashByCurrency: currencyAmountMap.optional(), handoverToName: z.string().optional(), salaryAmount: amount.optional(), salaryReceiver: z.string().optional() }) }), currencyMapLimits),
  shiftController.close
);

module.exports = router;
