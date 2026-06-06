const router = require("express").Router();
const { z, idParam } = require("../utils/validation");
const userController = require("../controllers/user.controller");
const validate = require("../middleware/validate.middleware");
const { requireRole } = require("../middleware/role.middleware");

router.get("/", userController.list);
router.post(
  "/",
  validate(
    z.object({
      body: z.object({
        login: z.string().trim().min(2),
        name: z.string().trim().min(2),
        password: z.string().min(6),
        role: z.enum(["SUPER_ADMIN", "BRANCH_ADMIN"]),
        branchId: z.string().optional().nullable(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  requireRole("SUPER_ADMIN"),
  userController.create
);
router.patch(
  "/:id",
  validate(
    idParam.extend({
      body: z.object({
        login: z.string().trim().min(2).optional(),
        name: z.string().trim().min(2).optional(),
        password: z.string().min(6).optional(),
        role: z.enum(["SUPER_ADMIN", "BRANCH_ADMIN"]).optional(),
        branchId: z.string().optional().nullable(),
        isActive: z.boolean().optional(),
      }),
    })
  ),
  requireRole("SUPER_ADMIN"),
  userController.update
);

module.exports = router;
