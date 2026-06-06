const router = require("express").Router();
const { z } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const analyticsController = require("../controllers/analytics.controller");

const query = z.object({ query: z.object({ branchId: z.string().optional(), dateFrom: z.string().optional(), dateTo: z.string().optional() }) });
router.get("/dashboard", validate(query), analyticsController.dashboard);
router.get("/reports", validate(query), analyticsController.reports);

module.exports = router;
