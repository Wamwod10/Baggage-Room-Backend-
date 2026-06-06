const router = require("express").Router();
const { z, idParam } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const notificationController = require("../controllers/notification.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), isRead: z.string().optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(200).optional() }) })), notificationController.list);
router.patch("/:id/read", validate(idParam), notificationController.readOne);
router.patch("/read-all", validate(z.object({ body: z.object({ branchId: z.string().optional() }).default({}) })), notificationController.readAll);

module.exports = router;
