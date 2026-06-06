const router = require("express").Router();
const { z, idParam, lockerStatus, lockerSize } = require("../utils/validation");
const validate = require("../middleware/validate.middleware");
const lockerController = require("../controllers/locker.controller");

router.get("/", validate(z.object({ query: z.object({ branchId: z.string().optional(), status: lockerStatus.optional(), size: lockerSize.optional(), search: z.string().optional() }) })), lockerController.list);
router.get("/:id", validate(idParam), lockerController.get);
router.patch("/:id/service", validate(idParam.extend({ body: z.object({ serviceReason: z.string().optional(), reason: z.string().optional() }) })), lockerController.service);
router.patch("/:id/restore", validate(idParam), lockerController.restore);
router.post(
  "/transfer",
  validate(
    z.object({
      body: z.object({
        orderId: z.string().min(1),
        fromLockerId: z.string().min(1),
        toLockerId: z.string().min(1),
        note: z.string().optional(),
      }),
    })
  ),
  lockerController.transfer
);

module.exports = router;
