const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { CURRENCIES, byCurrency } = require("../utils/money");
const { audit } = require("./activity.service");
const telegram = require("./telegram.service");
const googleSheets = require("./googleSheets.service");
const { createCashMovement } = require("./cashMovement.service");
const { summarizeMovements, cashBalanceByCurrency } = require("./cashAccounting.service");
const { requireIdempotencyKey, isUniqueConflictFor } = require("../utils/idempotency");

const include = {
  branch: { select: { id: true, name: true, code: true } },
  openedBy: { select: { id: true, name: true, login: true } },
  closedBy: { select: { id: true, name: true, login: true } },
};

const SALARY_NOTE_PREFIX = "Oylik:";

const isSalaryMovement = (movement) => movement.type === "EXPENSE" && String(movement.note || "").startsWith(SALARY_NOTE_PREFIX);
const normalizeCurrencyMap = (value, fallbackUzs = 0) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(CURRENCIES.map((currency) => {
    const amount = Number(source[currency] ?? (currency === "UZS" ? fallbackUzs : 0));
    return [currency, Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0];
  }));
};

const listShifts = async (user, query) => {
  const where = { ...branchWhere(user, query.branchId), ...dateRangeWhere(query.dateFrom, query.dateTo, "openedAt"), ...(query.status ? { status: query.status } : {}) };
  const limit = Math.min(Math.max(Number(query.limit || 50), 1), 100);
  const shifts = await prisma.shift.findMany({ where, include, orderBy: { openedAt: "desc" }, take: limit });
  if (!shifts.length) return [];

  const shiftIds = shifts.map((shift) => shift.id);
  const branchIds = [...new Set(shifts.map((shift) => shift.branchId))];
  const earliestOpen = shifts.reduce((earliest, shift) => shift.openedAt < earliest ? shift.openedAt : earliest, shifts[0].openedAt);
  const [movements, debts, orders] = await Promise.all([
    prisma.cashMovement.findMany({ where: { shiftId: { in: shiftIds } } }),
    prisma.debt.findMany({ where: { branchId: { in: branchIds }, createdAt: { gte: earliestOpen } } }),
    prisma.order.findMany({ where: { branchId: { in: branchIds }, createdAt: { gte: earliestOpen } }, select: { branchId: true, createdAt: true } }),
  ]);

  return shifts.map((shift) => {
    const reportEnd = shift.closedAt || new Date();
    return {
      ...shift,
      ...buildShiftReport(
        shift,
        movements.filter((item) => item.shiftId === shift.id),
        debts.filter((item) => item.branchId === shift.branchId && item.createdAt >= shift.openedAt && item.createdAt <= reportEnd),
        orders.filter((item) => item.branchId === shift.branchId && item.createdAt >= shift.openedAt && item.createdAt <= reportEnd).length,
      ),
    };
  });
};

const currentShift = async (user, query = {}) => {
  const branchId = getScopedBranchId(user, query.branchId || user.branchId);
  if (!branchId) return null;
  const shift = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" }, include, orderBy: { openedAt: "desc" } });
  if (!shift) return null;
  const { ordersCount, ...report } = await computeShiftReport(prisma, shift);
  return { ...shift, ...report, ordersCount };
};

const telegramReasonText = {
  settings_not_found: "Telegram sozlamalari topilmadi",
  missing_credentials: "Bot token yoki chat ID kiritilmagan",
  disabled: "Telegram o'chirilgan",
};

const sendCurrentSalesTelegram = async (user, query = {}) => {
  const branchId = getScopedBranchId(user, query.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);

  const shift = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" }, include, orderBy: { openedAt: "desc" } });
  if (!shift) throw new AppError("Bu filialda ochiq smena yo'q", 404);

  const { ordersCount, ...report } = await computeShiftReport(prisma, shift);
  const snapshot = { ...shift, ...report, ordersCount };
  const result = await telegram.sendSafely(
    () => telegram.sendShiftSalesSnapshot(snapshot),
    {
      action: "SHIFT_SALES_SNAPSHOT",
      branchId,
      userId: user.id,
      entityType: "ShiftSalesSnapshot",
      entityId: `${shift.id}:${Date.now()}`,
    },
  );

  if (result?.skipped) {
    const reason = result.error || result.reason || "Telegram yuborilmadi";
    throw new AppError(telegramReasonText[reason] || reason, result.error ? 502 : 400);
  }

  return {
    sent: true,
    messageId: result?.result?.message_id || null,
    shift: snapshot,
  };
};

const openShift = async (user, body, { idempotencyKey } = {}) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const replay = await prisma.shift.findUnique({ where: { idempotencyKey: requestKey }, include });
  if (replay) {
    if (replay.branchId !== branchId) throw new AppError("Idempotency key belongs to another branch", 409);
    return { ...replay, idempotentReplay: true };
  }
  const existing = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" } });
  if (existing) throw new AppError("This branch already has an open shift", 400);
  const openingCashByCurrency = normalizeCurrencyMap(body.openingCashByCurrency, body.openingCash);
  const acceptedCashByCurrency = normalizeCurrencyMap(body.acceptedCashByCurrency, body.acceptedCash);
  let shift;
  try {
    shift = await prisma.shift.create({
      data: {
        idempotencyKey: requestKey,
        branchId,
        openedById: user.id,
        openingCash: openingCashByCurrency.UZS,
        acceptedCash: acceptedCashByCurrency.UZS,
        openingCashByCurrency,
        acceptedCashByCurrency,
        acceptedFromName: body.acceptedFromName || null,
        acceptedByName: body.acceptedByName || null,
        handoverToName: body.handoverToName || null,
      },
      include,
    });
  } catch (error) {
    if (isUniqueConflictFor(error, "idempotencyKey")) {
      const existingByKey = await prisma.shift.findUnique({ where: { idempotencyKey: requestKey }, include });
      if (existingByKey?.branchId === branchId) return { ...existingByKey, idempotentReplay: true };
    }
    if (error?.code === "P2002") throw new AppError("This branch already has an open shift", 409);
    throw error;
  }
  await audit({ branchId, userId: user.id, entityType: "Shift", entityId: shift.id, action: "SHIFT_OPEN", newValue: shift, description: "Shift opened" });
  const result = { ...shift, openingCashByCurrency, acceptedCashByCurrency };
  telegram.sendSafely(() => telegram.sendShiftOpen(result), { action: "SHIFT_OPEN", branchId, userId: user.id, entityType: "Shift", entityId: shift.id });
  return result;
};

const buildShiftReport = (shift, movements, debts, ordersCount) => {
  const openDebts = debts.filter((item) => item.status === "OPEN");
  const summary = summarizeMovements(movements);
  const salaryMovements = summary.groups.expenses.filter(isSalaryMovement);
  const revenueByCurrency = summary.revenueByCurrency;
  const cashByCurrency = summary.cashByCurrency;
  const terminalByCurrency = summary.terminalByCurrency;
  const clickByCurrency = summary.clickByCurrency;
  const paymeByCurrency = summary.paymeByCurrency;
  const expenseByCurrency = summary.expenseByCurrency;
  const salaryByCurrency = byCurrency(salaryMovements);
  const inkassaByCurrency = summary.inkassaByCurrency;
  const debtByCurrency = byCurrency(openDebts);
  const openingCashByCurrency = normalizeCurrencyMap(shift.openingCashByCurrency, shift.openingCash);
  const acceptedCashByCurrency = normalizeCurrencyMap(shift.acceptedCashByCurrency, shift.acceptedCash);
  const balanceByCurrency = cashBalanceByCurrency({
    openingCashByCurrency,
    acceptedCashByCurrency,
    cashRevenueByCurrency: cashByCurrency,
    expenseByCurrency,
    inkassaByCurrency,
    manualInByCurrency: summary.manualInByCurrency,
    manualOutByCurrency: summary.manualOutByCurrency,
  });

  // Legacy Shift columns remain UZS values. Complete multi-currency values are
  // returned in the breakdown maps below and are never added across currencies.
  const totalRevenue = revenueByCurrency.UZS;
  const cashRevenue = cashByCurrency.UZS;
  const terminalRevenue = terminalByCurrency.UZS;
  const clickRevenue = clickByCurrency.UZS;
  const paymeRevenue = paymeByCurrency.UZS;
  const cardRevenue = terminalRevenue;
  const transferRevenue = summary.transferByCurrency.UZS;
  const expenseAmount = expenseByCurrency.UZS;
  const salaryAmount = salaryByCurrency.UZS;
  const inkassaAmount = inkassaByCurrency.UZS;
  const debtAmount = debtByCurrency.UZS;
  const systemExpectedCash = balanceByCurrency.UZS;

  return {
    totalRevenue,
    cashRevenue,
    cardRevenue,
    terminalRevenue,
    clickRevenue,
    paymeRevenue,
    transferRevenue,
    debtAmount,
    expenseAmount,
    salaryAmount,
    inkassaAmount,
    systemExpectedCash,
    ordersCount,
    openingCashByCurrency,
    acceptedCashByCurrency,
    revenueByCurrency,
    cashByCurrency,
    terminalByCurrency,
    clickByCurrency,
    paymeByCurrency,
    expenseByCurrency,
    salaryByCurrency,
    inkassaByCurrency,
    debtByCurrency,
    cashBalanceByCurrency: balanceByCurrency,
    paymentByCurrency: {
      CASH: cashByCurrency,
      TERMINAL: terminalByCurrency,
      CLICK: clickByCurrency,
      PAYME: paymeByCurrency,
    },
    report: {
      revenueByCurrency,
      openingCashByCurrency,
      acceptedCashByCurrency,
      cashByCurrency,
      terminalByCurrency,
      clickByCurrency,
      paymeByCurrency,
      expenseByCurrency,
      salaryByCurrency,
      inkassaByCurrency,
      debtByCurrency,
      cashBalanceByCurrency: balanceByCurrency,
    },
  };
};

const computeShiftReport = async (tx, shift) => {
  const reportEnd = shift.closedAt || new Date();
  const [movements, debts, ordersCount] = await Promise.all([
    tx.cashMovement.findMany({ where: { shiftId: shift.id } }),
    tx.debt.findMany({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: reportEnd } } }),
    tx.order.count({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: reportEnd } } }),
  ]);
  return buildShiftReport(shift, movements, debts, ordersCount);
};

const closeShift = async (user, id, body, { idempotencyKey } = {}) => {
  const requestKey = requireIdempotencyKey(idempotencyKey);
  const replay = await prisma.shift.findUnique({ where: { closeIdempotencyKey: requestKey }, include });
  if (replay) {
    getScopedBranchId(user, replay.branchId);
    if (replay.id !== id) throw new AppError("Idempotency key belongs to another shift", 409);
    return { ...replay, idempotentReplay: true };
  }
  const result = await prisma.$transaction(async (tx) => {
    const shift = await tx.shift.findUnique({ where: { id } });
    if (!shift || shift.status !== "OPEN") throw new AppError("Bu filialda ochiq smena yo'q", 404);
    getScopedBranchId(user, shift.branchId);
    const salaryAmount = Number(body.salaryAmount || 0);
    const salaryReceiver = String(body.salaryReceiver || "").trim();

    if (salaryAmount < 0) throw new AppError("Oylik summasi manfiy bo'lishi mumkin emas", 400);
    if (salaryAmount > 0 && !salaryReceiver) throw new AppError("Oylik uchun kimga berilganini kiriting", 400);

    const balanceBeforeSalary = await computeShiftReport(tx, shift);
    if (salaryAmount > Number(balanceBeforeSalary.cashBalanceByCurrency.UZS || 0)) {
      throw new AppError("Oylik summasi UZS kassasidagi qoldiqdan oshmasligi kerak", 400);
    }

    if (salaryAmount > 0) {
      await tx.expense.create({
        data: {
          branchId: shift.branchId,
          shiftId: shift.id,
          category: "Oylik",
          reason: salaryReceiver,
          amount: salaryAmount,
          currency: "UZS",
          createdById: user.id,
        },
      });
      await createCashMovement({
        tx,
        branchId: shift.branchId,
        shiftId: shift.id,
        type: "EXPENSE",
        direction: "OUT",
        amount: salaryAmount,
        currency: "UZS",
        note: `${SALARY_NOTE_PREFIX} ${salaryReceiver}`,
        createdById: user.id,
      });
    }

    const { ordersCount, ...report } = await computeShiftReport(tx, shift);
    const reportSalaryAmount = report.salaryAmount;
    const requestedClosing = normalizeCurrencyMap(body.closingCashByCurrency, body.closingCash ?? report.systemExpectedCash);
    const closingCashByCurrency = Object.fromEntries(CURRENCIES.map((currency) => [
      currency,
      body.closingCashByCurrency?.[currency] === undefined && currency !== "UZS"
        ? Number(report.cashBalanceByCurrency[currency] || 0)
        : requestedClosing[currency],
    ]));
    const differenceByCurrency = Object.fromEntries(CURRENCIES.map((currency) => [
      currency,
      Number(closingCashByCurrency[currency] || 0) - Number(report.cashBalanceByCurrency[currency] || 0),
    ]));
    const closingCash = closingCashByCurrency.UZS;
    const updatedWrite = await tx.shift.updateMany({
      where: { id, status: "OPEN" },
      data: {
        totalRevenue: report.totalRevenue,
        cashRevenue: report.cashRevenue,
        cardRevenue: report.cardRevenue,
        terminalRevenue: report.terminalRevenue,
        clickRevenue: report.clickRevenue,
        paymeRevenue: report.paymeRevenue,
        transferRevenue: report.transferRevenue,
        debtAmount: report.debtAmount,
        expenseAmount: report.expenseAmount,
        inkassaAmount: report.inkassaAmount,
        systemExpectedCash: report.systemExpectedCash,
        closingCash,
        closingCashByCurrency,
        difference: differenceByCurrency.UZS,
        differenceByCurrency,
        closedById: user.id,
        closedAt: new Date(),
        status: "CLOSED",
        closeIdempotencyKey: requestKey,
        handoverToName: body.handoverToName || shift.handoverToName,
      },
    });
    if (updatedWrite.count !== 1) throw new AppError("Bu smena boshqa operator tomonidan yopildi", 409);
    const updated = await tx.shift.findUnique({ where: { id }, include });
    const result = { ...updated, ...report, closingCashByCurrency, differenceByCurrency, salaryAmount: reportSalaryAmount, ordersCount, salaryReceiver: salaryAmount > 0 ? salaryReceiver : null };
    await audit({ tx, branchId: shift.branchId, userId: user.id, entityType: "Shift", entityId: id, action: "SHIFT_CLOSE", oldValue: shift, newValue: result, description: "Shift closed" });
    return result;
  }).catch(async (error) => {
    const existing = await prisma.shift.findUnique({ where: { closeIdempotencyKey: requestKey }, include });
    if (existing) {
      getScopedBranchId(user, existing.branchId);
      if (existing.id !== id) throw new AppError("Idempotency key belongs to another shift", 409);
      return { ...existing, idempotentReplay: true };
    }
    throw error;
  });
  if (result.idempotentReplay) return result;
  telegram.sendSafely(() => telegram.sendShiftClose(result), { action: "SHIFT_CLOSE", branchId: result.branchId, userId: user.id, entityType: "Shift", entityId: id });
  if (result.salaryReceiver && Number(result.salaryAmount || 0) > 0) {
    googleSheets.sendSafely(
      () => googleSheets.sendSalary({
        ...result,
        salaryEntityId: `${id}:salary`,
      }),
      { action: "SALARY", branchId: result.branchId, userId: user.id, entityType: "ShiftSalary", entityId: `${id}:salary` },
    );
  }
  return result;
};

module.exports = { listShifts, currentShift, sendCurrentSalesTelegram, openShift, closeShift, computeShiftReport, normalizeCurrencyMap };
