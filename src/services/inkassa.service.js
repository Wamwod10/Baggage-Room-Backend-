const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { AppError } = require("../utils/response");
const { audit } = require("./activity.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");

const includeInkassa = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
};

const listInkassa = async (user, query) => {
  const where = { ...branchWhere(user, query.branchId), ...dateRangeWhere(query.dateFrom, query.dateTo), ...(query.currency ? { currency: query.currency } : {}) };
  if (query.search) where.OR = [{ receiverName: { contains: query.search, mode: "insensitive" } }, { note: { contains: query.search, mode: "insensitive" } }];
  return prisma.inkassa.findMany({
    where,
    include: includeInkassa,
    orderBy: { createdAt: "desc" },
  });
};

const createInkassa = async (user, body) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const inkassa = await prisma.$transaction(async (tx) => {
    const shift = await findOpenShift(tx, branchId);
    const inkassa = await tx.inkassa.create({
      data: { branchId, shiftId: shift?.id || null, receiverName: body.receiverName, amount: body.amount, currency: body.currency || "UZS", note: body.note || null, createdById: user.id },
      include: includeInkassa,
    });
    await createCashMovement({ tx, branchId, shiftId: shift?.id || null, type: "INKASSA", direction: "OUT", amount: body.amount, currency: body.currency || "UZS", note: body.note || body.receiverName, createdById: user.id });
    await audit({ tx, branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id, action: "INKASSA_CREATE", newValue: inkassa, description: body.note || "Inkassa" });
    return inkassa;
  });
  telegram.sendSafely(telegram.sendInkassa(inkassa), { branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id });
  await googleSheets.sendSafely(googleSheets.sendInkassa(inkassa), { action: "INKASSA", branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id });
  return inkassa;
};

module.exports = { listInkassa, createInkassa };
