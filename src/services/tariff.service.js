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
const MULTI_ORDER_LOCKER_BRANCH_CODES = XL_BRANCH_CODES;

const calculatePrice = (tariff, hours, options = {}) => {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw new AppError('Invalid storage duration', 400);
  if (h > 72 && options.dailyRate !== undefined) {
    if (!Number.isSafeInteger(options.dailyRate) || options.dailyRate <= 0) throw new AppError('Daily tariff requires configuration', 409);
    return Math.ceil(h / 24) * options.dailyRate;
  }
  if (options.isCustom) return Number(tariff.price1h || 0) * Math.max(1, Math.ceil(h || 1));
  if (h <= 1) return tariff.price1h;
  if (h <= 12) return tariff.price12h;
  if (h <= 24) return tariff.price24h;
  if (h <= 48) return tariff.price48h;
  if (h <= 72) return tariff.price72h;
  return Math.round(Number(tariff.price72h || 0) + (h - 72) * (Number(tariff.after72hPrice || 0) / 24));
};

const dailyRatesForBranch = (code) => {
  const defaults = ['TSV', 'TJV', 'SVK'].includes(code)
    ? { S: 30000, M: 40000, L: 50000, XL: 80000 }
    : ['TIA', 'SIA'].includes(code) ? { S: 100000, M: 120000, L: 180000 } : null;
  if (!defaults) throw new AppError('Unknown branch pricing', 409);
  const configured = process.env.LONG_TERM_RATES_JSON ? JSON.parse(process.env.LONG_TERM_RATES_JSON) : {};
  const rates = configured[code] || defaults;
  for (const size of sizesForBranch({ code })) {
    if (!Number.isSafeInteger(rates[size]) || rates[size] <= 0) throw new AppError('Invalid configured daily tariff', 409);
  }
  return rates;
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

module.exports = {
  calculatePrice,
  dailyRatesForBranch,
  listTariffs,
  updateTariff,
  sizesForBranch,
  XL_BRANCH_CODES,
  MULTI_ORDER_LOCKER_BRANCH_CODES,
};
