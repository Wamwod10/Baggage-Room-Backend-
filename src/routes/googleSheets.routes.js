const router = require("express").Router();
const { z } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const { requireRole } = require("../middleware/role.middleware");
const googleSheetsController = require("../controllers/googleSheets.controller");

router.post(
  "/test",
  requireRole("SUPER_ADMIN"),
  validate(z.object({ body: z.object({ branchCode: z.string().trim().min(1), action: z.enum(["NEW_ORDER", "DOPLATA", "DEBT_PAYMENT", "EXPENSE", "INKASSA", "SALARY"]) }) })),
  googleSheetsController.test,
);

module.exports = router;
