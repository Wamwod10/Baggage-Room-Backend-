const router = require("express").Router();
const { z, idParam, amount, currency, paymentType } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const debtController = require("../controllers/debt.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), status: z.enum(["OPEN", "CLOSED"]).optional(), currency: currency.optional(), search: z.string().optional() }) })), debtController.list);
router.post("/:id/close", validate(idParam.extend({ body: z.object({ amount: amount.optional(), currency: currency.optional(), paymentType: paymentType.optional(), note: z.string().optional() }) })), debtController.close);

module.exports = router;
