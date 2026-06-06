const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { AppError, asyncHandler } = require("../utils/response");

const authMiddleware = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("Authentication token is required", 401);
  }

  const token = header.slice(7);
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const user = await prisma.user.findUnique({
    where: { id: payload.id },
    select: {
      id: true,
      login: true,
      name: true,
      role: true,
      branchId: true,
      isActive: true,
      branch: { select: { id: true, name: true, code: true } },
    },
  });

  if (!user || !user.isActive) throw new AppError("User is not active", 401);
  req.user = user;
  next();
});

module.exports = authMiddleware;
