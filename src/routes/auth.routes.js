const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const authController = require("../controllers/auth.controller");
const authMiddleware = require("../middleware/auth.middleware");
const validate = require("../middleware/validate.middleware");
const configuredLoginRateLimit = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || "", 10);
const loginRateLimitMax = Number.isInteger(configuredLoginRateLimit)
  ? Math.min(Math.max(configuredLoginRateLimit, 5), 1000)
  : 20;

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: loginRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: "Login urinishlari vaqtincha cheklangan. Birozdan keyin qayta urinib ko'ring.",
  },
});

router.post(
  "/login",
  loginRateLimit,
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
