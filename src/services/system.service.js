const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");

const RESET_CONFIRMATION = "RESET";

const countSnapshot = async (client) => ({
  users: await client.user.count(),
  branches: await client.branch.count(),
  lockers: await client.locker.count(),
  emptyLockers: await client.locker.count({
    where: {
      status: "EMPTY",
      currentOrderId: null,
      serviceReason: null,
    },
  }),
  tariffs: await client.tariff.count(),
  telegramSettings: await client.telegramSetting.count(),
  orders: await client.order.count(),
  orderItems: await client.orderItem.count(),
  shifts: await client.shift.count(),
  expenses: await client.expense.count(),
  inkassa: await client.inkassa.count(),
  cashMovements: await client.cashMovement.count(),
  debts: await client.debt.count(),
  notifications: await client.notification.count(),
  auditLogs: await client.auditLog.count(),
});

const resetData = async (user, body = {}) => {
  if (body.confirm !== RESET_CONFIRMATION) {
    throw new AppError("Reset uchun RESET deb tasdiqlang", 400);
  }

  const before = await countSnapshot(prisma);

  const result = await prisma.$transaction(
    async (tx) => {
      const resetLockers = await tx.locker.updateMany({
        data: {
          status: "EMPTY",
          currentOrderId: null,
          serviceReason: null,
        },
      });

      const deleted = {
        notifications: await tx.notification.deleteMany(),
        auditLogs: await tx.auditLog.deleteMany(),
        debts: await tx.debt.deleteMany(),
        cashMovements: await tx.cashMovement.deleteMany(),
        inkassa: await tx.inkassa.deleteMany(),
        expenses: await tx.expense.deleteMany(),
        shifts: await tx.shift.deleteMany(),
        orderItems: await tx.orderItem.deleteMany(),
        orders: await tx.order.deleteMany(),
      };

      return {
        resetBy: user.id,
        resetLockers: resetLockers.count,
        deleted: Object.fromEntries(Object.entries(deleted).map(([key, value]) => [key, value.count])),
      };
    },
    { maxWait: 10000, timeout: 120000 },
  );

  const after = await countSnapshot(prisma);

  return {
    before,
    result,
    after,
  };
};

module.exports = { RESET_CONFIRMATION, resetData };
