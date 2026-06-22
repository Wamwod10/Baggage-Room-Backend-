const router = require("express").Router();
const { z, idParam, amount } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const shiftController = require("../controllers/shift.controller");
const currencyAmountMap = z.record(z.enum(["UZS", "USD", "EUR", "RUB"]), amount);

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), status: z.enum(["OPEN", "CLOSED"]).optional() }) })), shiftController.list);
router.get("/current", validate(z.object({ query: z.object({ branchId: z.string().optional() }) })), shiftController.current);
router.post(
  "/open",
  validate(z.object({ body: z.object({ branchId: z.string().optional(), openingCash: amount.default(0), acceptedCash: amount.default(0), openingCashByCurrency: currencyAmountMap.optional(), acceptedCashByCurrency: currencyAmountMap.optional(), acceptedFromName: z.string().optional(), acceptedByName: z.string().optional(), handoverToName: z.string().optional() }) })),
  shiftController.open
);
router.post(
  "/:id/close",
  validate(idParam.extend({ body: z.object({ closingCash: amount.optional(), closingCashByCurrency: currencyAmountMap.optional(), handoverToName: z.string().optional(), salaryAmount: amount.optional(), salaryReceiver: z.string().optional() }) })),
  shiftController.close
);

module.exports = router;
