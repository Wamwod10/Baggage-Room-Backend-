const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");

const publicUserSelect = {
  id: true,
  login: true,
  name: true,
  role: true,
  branchId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, name: true, code: true } },
};

const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role, branchId: user.branchId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });

const login = async ({ login: loginName, password }) => {
  const user = await prisma.user.findUnique({
    where: { login: loginName },
    include: { branch: { select: { id: true, name: true, code: true } } },
  });
  if (!user || !user.isActive) throw new AppError("Invalid login or password", 401);

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) throw new AppError("Invalid login or password", 401);

  const { passwordHash, ...safeUser } = user;
  return { token: signToken(user), user: safeUser };
};

const me = async (userId) => {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: publicUserSelect });
  if (!user) throw new AppError("User not found", 404);
  return user;
};

module.exports = { login, me, publicUserSelect };
