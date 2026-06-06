const router = require("express").Router();
const { z, currency, paymentType } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const cashMovementController = require("../controllers/cashMovement.controller");

router.get(
  "/",
  validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), currency: currency.optional(), paymentType: paymentType.optional(), search: z.string().optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(200).optional() }) })),
  cashMovementController.list
);

module.exports = router;
