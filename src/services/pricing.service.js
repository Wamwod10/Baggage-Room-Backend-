const prisma = require('../config/prisma');
const { calculatePrice, dailyRatesForBranch } = require('./tariff.service');
const { convertUzsToCurrencyMinor } = require('../utils/money');
const { getScopedBranchId } = require('../utils/scope');
const { AppError } = require('../utils/response');
const { assertMinorAmount, validateBaggage } = require('./financialControls');
const cbu = require('./cbuRates.service');
const quote = async (user, body) => {
  getScopedBranchId(user, body.branchId);
  const branch = await prisma.branch.findUnique({ where: { id: body.branchId } });
  if (!branch) throw new AppError('Branch not found', 404);
  validateBaggage(body.items, branch.code);
  const tariffs = await prisma.tariff.findMany({ where: { branchId: branch.id } });
  const fx = await cbu.getRate(body.currency || 'UZS');
  const dailyRates = dailyRatesForBranch(branch.code);
  const items = body.items.map((item) => {
    const tariff = tariffs.find((row) => row.size === item.size);
    if (!tariff) throw new AppError('Tariff not found', 409);
    const unitPriceUZS = calculatePrice(tariff, body.hours, { branchCode: branch.code, isCustom: body.isCustom, dailyRate: dailyRates[item.size] });
    const unitPrice = convertUzsToCurrencyMinor(unitPriceUZS, body.currency || 'UZS', fx.rate);
    return { ...item, unitPriceUZS, unitPrice, amount: assertMinorAmount(unitPrice * item.count) };
  });
  let canAdjustPrice = false;
  try { require('./financialControls').assertPricePermission(user, 'Capability check'); canAdjustPrice = true; } catch { /* Fail closed. */ }
  return { items, calculatedAmount: assertMinorAmount(items.reduce((sum, item) => sum + item.amount, 0)), canAdjustPrice,
    exchangeRate: fx.rate, fxSource: fx.source, fxEffectiveDate: fx.effectiveDate,
    fxNominal: fx.nominal, fxPublishedRate: fx.publishedRate };
};
const pickupQuote = async (user, id) => {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true, branch: true } });
  if (!order) throw new AppError('Order not found', 404);
  getScopedBranchId(user, order.branchId);
  const tariffs = await prisma.tariff.findMany({ where: { branchId: order.branchId } });
  const actualTime = new Date();
  const hours = require('../utils/overtime').overtimeHoursAfterGrace(order.plannedCheckOut, actualTime);
  return { hours, amount: require('./order.service')._internals.calculateOvertimeAmount({ order, tariffs, overtimeHours: hours, actualTime }), quotedAt: actualTime };
};
module.exports = { quote, pickupQuote };
