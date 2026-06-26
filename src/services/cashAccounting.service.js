const { CURRENCIES, byCurrency, subtractCurrencyMaps, sum } = require("../utils/money");

const REVENUE_IN_TYPES = Object.freeze(["ORDER_PAYMENT", "DEBT_CLOSE"]);
const CASH_BALANCE_IN_TYPES = Object.freeze([...REVENUE_IN_TYPES, "MANUAL_CORRECTION"]);
const CASH_BALANCE_OUT_TYPES = Object.freeze(["EXPENSE", "INKASSA", "MANUAL_CORRECTION"]);
const CASH_PAYMENT_TYPES = Object.freeze(["CASH"]);
const TERMINAL_PAYMENT_TYPES = Object.freeze(["TERMINAL", "CARD", "TRANSFER"]);

const isDirection = (direction) => (movement) => movement.direction === direction;
const isTypeIn = (types) => (movement) => types.includes(movement.type);
const isPaymentTypeIn = (types) => (movement) => types.includes(movement.paymentType);

const revenueInMovements = (movements = []) =>
  movements.filter((movement) => movement.direction === "IN" && REVENUE_IN_TYPES.includes(movement.type));

const cashBalanceInMovements = (movements = []) =>
  movements.filter((movement) => movement.direction === "IN" && CASH_BALANCE_IN_TYPES.includes(movement.type));

const cashBalanceOutMovements = (movements = []) =>
  movements.filter((movement) => movement.direction === "OUT" && CASH_BALANCE_OUT_TYPES.includes(movement.type));

const movementGroups = (movements = []) => {
  const revenueIn = revenueInMovements(movements);
  const balanceIn = cashBalanceInMovements(movements);
  const balanceOut = cashBalanceOutMovements(movements);
  const out = movements.filter(isDirection("OUT"));
  const expenses = balanceOut.filter(isTypeIn(["EXPENSE"]));
  const inkassa = balanceOut.filter(isTypeIn(["INKASSA"]));
  const manualIn = balanceIn.filter(isTypeIn(["MANUAL_CORRECTION"]));
  const manualOut = balanceOut.filter(isTypeIn(["MANUAL_CORRECTION"]));

  return {
    revenueIn,
    balanceIn,
    balanceOut,
    out,
    cashRevenue: revenueIn.filter(isPaymentTypeIn(CASH_PAYMENT_TYPES)),
    terminalRevenue: revenueIn.filter(isPaymentTypeIn(TERMINAL_PAYMENT_TYPES)),
    clickRevenue: revenueIn.filter(isPaymentTypeIn(["CLICK"])),
    paymeRevenue: revenueIn.filter(isPaymentTypeIn(["PAYME"])),
    transferRevenue: revenueIn.filter(isPaymentTypeIn(["TRANSFER"])),
    expenses,
    inkassa,
    manualIn,
    manualOut,
  };
};

const sumCurrencyMaps = (maps = []) => CURRENCIES.reduce((result, currency) => {
  result[currency] = maps.reduce((total, map) => total + Number(map?.[currency] || 0), 0);
  return result;
}, {});

const cashBalanceByCurrency = ({
  openingCashByCurrency = {},
  acceptedCashByCurrency = {},
  cashRevenueByCurrency = {},
  expenseByCurrency = {},
  inkassaByCurrency = {},
  manualInByCurrency = {},
  manualOutByCurrency = {},
} = {}) =>
  subtractCurrencyMaps(
    sumCurrencyMaps([openingCashByCurrency, acceptedCashByCurrency, cashRevenueByCurrency, manualInByCurrency]),
    expenseByCurrency,
    inkassaByCurrency,
    manualOutByCurrency,
  );

const summarizeMovements = (movements = []) => {
  const groups = movementGroups(movements);
  return {
    groups,
    revenueByCurrency: byCurrency(groups.revenueIn),
    cashByCurrency: byCurrency(groups.cashRevenue),
    terminalByCurrency: byCurrency(groups.terminalRevenue),
    clickByCurrency: byCurrency(groups.clickRevenue),
    paymeByCurrency: byCurrency(groups.paymeRevenue),
    transferByCurrency: byCurrency(groups.transferRevenue),
    expenseByCurrency: byCurrency(groups.expenses),
    inkassaByCurrency: byCurrency(groups.inkassa),
    manualInByCurrency: byCurrency(groups.manualIn),
    manualOutByCurrency: byCurrency(groups.manualOut),
    revenueAmount: sum(groups.revenueIn),
    cashAmount: sum(groups.cashRevenue),
    terminalAmount: sum(groups.terminalRevenue),
    clickAmount: sum(groups.clickRevenue),
    paymeAmount: sum(groups.paymeRevenue),
    transferAmount: sum(groups.transferRevenue),
    expenseAmount: sum(groups.expenses),
    inkassaAmount: sum(groups.inkassa),
  };
};

module.exports = {
  REVENUE_IN_TYPES,
  CASH_BALANCE_IN_TYPES,
  CASH_BALANCE_OUT_TYPES,
  revenueInMovements,
  cashBalanceInMovements,
  cashBalanceOutMovements,
  movementGroups,
  summarizeMovements,
  cashBalanceByCurrency,
  sumCurrencyMaps,
};
