const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { AppError } = require("../utils/response");
const { audit } = require("./activity.service");
const { findOpenShift, createCashMovement } = require("./cashMovement.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");
const { computeShiftReport } = require("./shift.service");
const { requireIdempotencyKey, isUniqueConflictFor } = require("../utils/idempotency");

const includeInkassa = {
  branch: { select: { id: true, name: true, code: true } },
  createdBy: { select: { id: true, name: true, login: true } },
  shift: { select: { id: true, acceptedByName: true, openedBy: { select: { id: true, name: true, login: true } } } },
};

const listInkassa = async (user, query) => {
  const where = { ...branchWhere(user, query.branchId), ...dateRangeWhere(query.dateFrom, query.dateTo), ...(query.currency ? { currency: query.currency } : {}) };
  if (query.search) where.OR = [{ receiverName: { contains: query.search, mode: "insensitive" } }, { note: { contains: query.search, mode: "insensitive" } }];
  return prisma.inkassa.findMany({
    where,
    include: includeInkassa,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(Number(query.limit || 200), 1), 200),
  });
};

const createInkassa = async (user, body, { idempotencyKey } = {}) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const existing = await prisma.inkassa.findUnique({ where: { idempotencyKey: requestKey }, include: includeInkassa });
  if (existing) {
    if (existing.branchId !== branchId) throw new AppError("Idempotency key belongs to another branch", 409);
    return { ...existing, adminName: existing.shift?.acceptedByName || null, idempotentReplay: true };
  }
  let inkassa;
  try {
    inkassa = await prisma.$transaction(async (tx) => {
    const shift = await findOpenShift(tx, branchId);
    if (!shift) throw new AppError("Inkassa uchun ochiq smena talab qilinadi", 400);
    const currency = body.currency || "UZS";
    const report = await computeShiftReport(tx, shift);
    const available = Number(report.cashBalanceByCurrency?.[currency] || 0);
    if (Number(body.amount || 0) > available) {
      throw new AppError(`${currency} kassasida inkassa uchun mablag' yetarli emas`, 400, [
        { field: "amount", message: `Mavjud qoldiq: ${available} ${currency} minor birlik` },
      ]);
    }
    const inkassa = await tx.inkassa.create({
      data: { idempotencyKey: requestKey, branchId, shiftId: shift.id, receiverName: body.receiverName, amount: body.amount, currency, note: body.note || null, createdById: user.id },
      include: includeInkassa,
    });
    await createCashMovement({ tx, branchId, shiftId: shift.id, type: "INKASSA", direction: "OUT", amount: body.amount, currency, note: body.note || body.receiverName, createdById: user.id });
    await audit({ tx, branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id, action: "INKASSA_CREATE", newValue: inkassa, description: body.note || "Inkassa" });
    return inkassa;
    });
  } catch (error) {
    if (!isUniqueConflictFor(error, "idempotencyKey")) throw error;
    inkassa = await prisma.inkassa.findUnique({ where: { idempotencyKey: requestKey }, include: includeInkassa });
    if (!inkassa || inkassa.branchId !== branchId) throw error;
    return { ...inkassa, adminName: inkassa.shift?.acceptedByName || null, idempotentReplay: true };
  }
  const payload = {
    ...inkassa,
    adminName: inkassa.shift?.acceptedByName || null,
  };
  telegram.sendSafely(() => telegram.sendInkassa(payload), { action: "INKASSA", branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id });
  googleSheets.sendSafely(() => googleSheets.sendInkassa(payload), { action: "INKASSA", branchId, userId: user.id, entityType: "Inkassa", entityId: inkassa.id });
  return payload;
};

module.exports = { listInkassa, createInkassa };
