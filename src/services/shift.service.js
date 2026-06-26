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
  const shifts = await prisma.shift.findMany({ where, include, orderBy: { openedAt: "desc" } });
  return Promise.all(shifts.map(async (shift) => ({
    ...shift,
    ...(await computeShiftReport(prisma, shift)),
  })));
};

const currentShift = async (user, query = {}) => {
  const branchId = getScopedBranchId(user, query.branchId || user.branchId);
  if (!branchId) return null;
  const shift = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" }, include, orderBy: { openedAt: "desc" } });
  if (!shift) return null;
  const { ordersCount, ...report } = await computeShiftReport(prisma, shift);
  return { ...shift, ...report, ordersCount };
};

const openShift = async (user, body) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  if (!branchId) throw new AppError("branchId is required", 400);
  const existing = await prisma.shift.findFirst({ where: { branchId, status: "OPEN" } });
  if (existing) throw new AppError("This branch already has an open shift", 400);
  const openingCashByCurrency = normalizeCurrencyMap(body.openingCashByCurrency, body.openingCash);
  const acceptedCashByCurrency = normalizeCurrencyMap(body.acceptedCashByCurrency, body.acceptedCash);
  const shift = await prisma.shift.create({
    data: {
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
  await audit({ branchId, userId: user.id, entityType: "Shift", entityId: shift.id, action: "SHIFT_OPEN", newValue: shift, description: "Shift opened" });
  const result = { ...shift, openingCashByCurrency, acceptedCashByCurrency };
  telegram.sendSafely(() => telegram.sendShiftOpen(result), { action: "SHIFT_OPEN", branchId, userId: user.id, entityType: "Shift", entityId: shift.id });
  return result;
};

const computeShiftReport = async (tx, shift) => {
  const movements = await tx.cashMovement.findMany({ where: { shiftId: shift.id } });
  const reportEnd = shift.closedAt || new Date();
  const debts = await tx.debt.findMany({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: reportEnd } } });
  const ordersCount = await tx.order.count({ where: { branchId: shift.branchId, createdAt: { gte: shift.openedAt, lte: reportEnd } } });

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

const closeShift = async (user, id, body) => {
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
    const updated = await tx.shift.update({
      where: { id },
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
        handoverToName: body.handoverToName || shift.handoverToName,
      },
      include,
    });
    const result = { ...updated, ...report, closingCashByCurrency, differenceByCurrency, salaryAmount: reportSalaryAmount, ordersCount, salaryReceiver: salaryAmount > 0 ? salaryReceiver : null };
    await audit({ tx, branchId: shift.branchId, userId: user.id, entityType: "Shift", entityId: id, action: "SHIFT_CLOSE", oldValue: shift, newValue: result, description: "Shift closed" });
    return result;
  });
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

module.exports = { listShifts, currentShift, openShift, closeShift, computeShiftReport, normalizeCurrencyMap };
