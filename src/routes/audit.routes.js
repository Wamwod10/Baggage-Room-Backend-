const router = require("express").Router();
const { z } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const auditController = require("../controllers/audit.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional(), entityType: z.string().optional(), action: z.string().optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(200).optional() }) })), auditController.list);

module.exports = router;
