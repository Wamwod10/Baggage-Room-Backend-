const router = require("express").Router();
const { z, branchParam } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const telegramController = require("../controllers/telegram.controller");
const { requireRole } = require("../middleware/role.middleware");

const settingsBody = z.object({
  botToken: z.string().optional().nullable(),
  groupId: z.string().optional().nullable(),
  enabled: z.boolean().optional(),
  newOrderEnabled: z.boolean().optional(),
  shiftOpenEnabled: z.boolean().optional(),
  shiftCloseEnabled: z.boolean().optional(),
  orderCancelEnabled: z.boolean().optional(),
  delayedBaggageEnabled: z.boolean().optional(),
  overtimePaymentEnabled: z.boolean().optional(),
  debtClosedEnabled: z.boolean().optional(),
  inkassaEnabled: z.boolean().optional(),
  expenseEnabled: z.boolean().optional(),
  orderEditEnabled: z.boolean().optional(),
  lockerTransferEnabled: z.boolean().optional(),
  lockerServiceEnabled: z.boolean().optional(),
});

router.get("/settings", validate(z.object({ query: z.object({ branchId: z.string().optional() }) })), requireRole("SUPER_ADMIN"), telegramController.settings);
router.patch("/settings/:branchId", validate(branchParam.extend({ body: settingsBody })), requireRole("SUPER_ADMIN"), telegramController.update);
router.post("/test/:branchId", validate(branchParam), requireRole("SUPER_ADMIN"), telegramController.test);

module.exports = router;
