const router = require("express").Router();
const { z } = require("zod");
const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");

router.post(
  "/login",
  validate(
    z.object({
      body: z.object({
        login: z.string().trim().min(2),
        password: z.string().min(6),
      }),
    })
  ),
  authController.login
);

router.get("/me", authMiddleware, authController.me);

module.exports = router;
