const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere } = require("../utils/scope");
const { audit } = require("./activity.service");

const ZERO_TARIFF = {
  price1h: 0,
  price12h: 0,
  price24h: 0,
  price48h: 0,
  price72h: 0,
  after72hPrice: 0,
};
const BASE_BAGGAGE_SIZES = ["S", "M", "L"];
const XL_BRANCH_CODES = new Set(["TSV", "TJV", "SVK"]);

const calculatePrice = (tariff, hours) => {
  const h = Number(hours);
  if (h <= 1) return tariff.price1h;
  if (h <= 12) return tariff.price12h;
  if (h <= 24) return tariff.price24h;
  if (h <= 48) return tariff.price48h;
  if (h <= 72) return tariff.price72h;
  return tariff.price72h + Math.ceil((h - 72) / 24) * tariff.after72hPrice;
};

const sizesForBranch = (branch) => [
  ...BASE_BAGGAGE_SIZES,
  ...(XL_BRANCH_CODES.has(branch.code) ? ["XL"] : []),
];

const ensureTariffs = async (where) => {
  const branches = await prisma.branch.findMany({ where: where.branchId ? { id: where.branchId } : {}, select: { id: true, code: true } });
  for (const branch of branches) {
    for (const size of sizesForBranch(branch)) {
      await prisma.tariff.upsert({
        where: { branchId_size: { branchId: branch.id, size } },
        update: {},
        create: { branchId: branch.id, size, ...ZERO_TARIFF },
      });
    }
  }
};

const listTariffs = async (user, query) => {
  const where = branchWhere(user, query.branchId);
  await ensureTariffs(where);
  return prisma.tariff.findMany({
    where,
    include: { branch: { select: { id: true, name: true, code: true } } },
    orderBy: [{ branch: { name: "asc" } }, { size: "asc" }],
  });
};

const updateTariff = async (user, id, data) => {
  if (user.role !== "SUPER_ADMIN") throw new AppError("Only super admin can update tariffs", 403);
  const oldValue = await prisma.tariff.findUnique({ where: { id } });
  if (!oldValue) throw new AppError("Tariff not found", 404);

  const updated = await prisma.tariff.update({ where: { id }, data });
  await audit({
    branchId: updated.branchId,
    userId: user.id,
    entityType: "Tariff",
    entityId: updated.id,
    action: "TARIFF_UPDATE",
    oldValue,
    newValue: updated,
    description: "Tariff updated",
  });
  return updated;
};

module.exports = { calculatePrice, listTariffs, updateTariff, sizesForBranch, XL_BRANCH_CODES };
