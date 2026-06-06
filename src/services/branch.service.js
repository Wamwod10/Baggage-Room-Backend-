const prisma = require("../config/prisma");

const listBranches = async (user) => {
  const where = user.role === "SUPER_ADMIN" ? {} : { id: user.branchId };
  return prisma.branch.findMany({
    where,
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true, isActive: true, createdAt: true, updatedAt: true },
  });
};

module.exports = { listBranches };
