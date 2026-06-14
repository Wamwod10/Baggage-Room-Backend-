const router = require("express").Router();
const { z } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const { requireRole } = require("../middleware/role.middleware");
const systemController = require("../controllers/system.controller");
const { RESET_CONFIRMATION } = require("../services/system.service");

router.post(
  "/reset-data",
  requireRole("SUPER_ADMIN"),
  validate(z.object({ body: z.object({ confirm: z.literal(RESET_CONFIRMATION) }) })),
  systemController.resetData,
);

module.exports = router;
