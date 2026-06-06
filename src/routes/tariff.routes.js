const router = require("express").Router();
const { z, idParam, amount } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const tariffController = require("../controllers/tariff.controller");
const { requireRole } = require("../middleware/role.middleware");

router.get("/", tariffController.list);
router.patch(
  "/:id",
  validate(
    idParam.extend({
      body: z.object({
        price1h: amount.optional(),
        price12h: amount.optional(),
        price24h: amount.optional(),
        price48h: amount.optional(),
        price72h: amount.optional(),
        after72hPrice: amount.optional(),
      }),
    })
  ),
  requireRole("SUPER_ADMIN"),
  tariffController.update
);

module.exports = router;
