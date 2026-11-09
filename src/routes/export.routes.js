const router = require("express").Router();
const { z, currency, paymentType } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const exportController = require("../controllers/export.controller");

const query = z.object({
  query: z.object({
    branchId: z.string().optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    status: z.string().optional(),
    paymentType: paymentType.optional(),
    currency: currency.optional(),
    search: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(10000).optional(),
  }),
});

router.get("/orders/monthly-pdf", validate(z.object({ query: z.object({
  month: z.string().regex(/^(20[0-9]{2})-(0[1-9]|1[0-2])$/),
  branchId: z.string().optional(),
}) })), exportController.monthlySalesPdf);
router.get("/orders", validate(query), exportController.orders);
router.get("/shifts", validate(query), exportController.shifts);
router.get("/finance", validate(query), exportController.finance);

module.exports = router;
