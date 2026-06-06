const router = require("express").Router();
const { z, idParam, amount, currency } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const expenseController = require("../controllers/expense.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), currency: currency.optional(), search: z.string().optional() }) })), expenseController.list);
router.post(
  "/",
  validate(z.object({ body: z.object({ branchId: z.string().optional(), category: z.string().trim().min(2), reason: z.string().trim().min(2), amount, currency: currency.default("UZS") }) })),
  expenseController.create
);
router.delete("/:id", validate(idParam), expenseController.remove);

module.exports = router;
