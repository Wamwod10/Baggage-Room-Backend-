const router = require("express").Router();
const { z, amount, currency } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const inkassaController = require("../controllers/inkassa.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), currency: currency.optional(), search: z.string().optional() }) })), inkassaController.list);
router.post("/", validate(z.object({ body: z.object({ branchId: z.string().optional(), shiftId: z.string().optional(), receiverName: z.string().trim().min(2), amount, currency: currency.default("UZS"), note: z.string().optional() }) })), inkassaController.create);

module.exports = router;
