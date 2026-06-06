const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { publicUserSelect } = require("./auth.service");

const listUsers = async (user, query) => {
  const where = {};
  if (user.role !== "SUPER_ADMIN") where.branchId = user.branchId;
  if (query.branchId && user.role === "SUPER_ADMIN") where.branchId = query.branchId;
  if (query.search) {
    where.OR = [
      { login: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
    ];
  }
  return prisma.user.findMany({ where, select: publicUserSelect, orderBy: { createdAt: "desc" } });
};

const createUser = async (actor, data) => {
  if (actor.role !== "SUPER_ADMIN") throw new AppError("Only super admin can create users", 403);
  if (data.role === "BRANCH_ADMIN" && !data.branchId) throw new AppError("Branch admin must have branchId", 400);
  const passwordHash = await bcrypt.hash(data.password, 12);
  return prisma.user.create({
    data: {
      login: data.login,
      name: data.name,
      passwordHash,
      role: data.role,
      branchId: data.branchId || null,
      isActive: data.isActive ?? true,
    },
    select: publicUserSelect,
  });
};

const updateUser = async (actor, id, data) => {
  if (actor.role !== "SUPER_ADMIN") throw new AppError("Only super admin can update users", 403);
  const update = { ...data };
  delete update.password;
  if (data.password) update.passwordHash = await bcrypt.hash(data.password, 12);
  return prisma.user.update({ where: { id }, data: update, select: publicUserSelect });
};

module.exports = { listUsers, createUser, updateUser };
