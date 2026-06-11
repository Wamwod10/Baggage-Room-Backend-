const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { audit } = require("./activity.service");
const telegram = require("./telegram.service");

const include = {
  branch: { select: { id: true, name: true, code: true } },
  currentOrder: { select: { id: true, orderNumber: true, clientName: true, phone: true, status: true } },
};

const listLockers = async (user, query) => {
  const where = {
    ...branchWhere(user, query.branchId),
    ...(query.status ? { status: query.status } : {}),
    ...(query.size ? { size: query.size } : {}),
  };
  if (query.search) {
    const number = Number(query.search);
    if (!Number.isNaN(number)) where.number = number;
  }
  return prisma.locker.findMany({ where, include, orderBy: [{ branchId: "asc" }, { number: "asc" }] });
};

const getLocker = async (user, id) => {
  const locker = await prisma.locker.findUnique({ where: { id }, include });
  if (!locker) throw new AppError("Locker not found", 404);
  getScopedBranchId(user, locker.branchId);
  return locker;
};

const setService = async (user, id, data) => {
  const locker = await getLocker(user, id);
  if (locker.status === "BUSY" || locker.currentOrderId) throw new AppError("Busy locker cannot be moved to service", 400);
  const updated = await prisma.locker.update({
    where: { id },
    data: { status: "SERVICE", serviceReason: data.serviceReason || data.reason || null },
  });
  await audit({
    branchId: locker.branchId,
    userId: user.id,
    entityType: "Locker",
    entityId: id,
    action: "LOCKER_SERVICE",
    oldValue: locker,
    newValue: updated,
    description: "Locker moved to service",
  });
  telegram.sendSafely(telegram.sendLockerService({ branchId: locker.branchId, branch: locker.branch, locker: locker.number, status: "SERVICE", reason: data.serviceReason || data.reason, createdBy: user }), { branchId: locker.branchId, userId: user.id, entityType: "Locker", entityId: id });
  return updated;
};

const restore = async (user, id) => {
  const locker = await getLocker(user, id);
  if (locker.currentOrderId) throw new AppError("Locker with active order cannot be restored", 400);
  const updated = await prisma.locker.update({
    where: { id },
    data: { status: "EMPTY", serviceReason: null },
  });
  await audit({
    branchId: locker.branchId,
    userId: user.id,
    entityType: "Locker",
    entityId: id,
    action: "LOCKER_RESTORE",
    oldValue: locker,
    newValue: updated,
    description: "Locker restored from service",
  });
  telegram.sendSafely(telegram.sendLockerService({ branchId: locker.branchId, branch: locker.branch, locker: locker.number, status: "EMPTY", reason: locker.serviceReason, createdBy: user }), { branchId: locker.branchId, userId: user.id, entityType: "Locker", entityId: id });
  return updated;
};

const transfer = async (user, data) => {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: data.orderId }, include: { items: true, branch: { select: { id: true, name: true } } } });
    if (!order || !["ACTIVE", "DELAYED"].includes(order.status)) throw new AppError("Active order not found", 404);
    getScopedBranchId(user, order.branchId);

    const from = await tx.locker.findUnique({ where: { id: data.fromLockerId } });
    const to = await tx.locker.findUnique({ where: { id: data.toLockerId } });
    if (!from || !to) throw new AppError("Locker not found", 404);
    if (from.branchId !== order.branchId || to.branchId !== order.branchId) throw new AppError("Lockers must be in order branch", 400);
    if (to.status !== "EMPTY" || to.currentOrderId) throw new AppError("Target locker is not available", 400);

    const hasSourceItems = order.items.some((orderItem) => orderItem.lockerId === from.id);
    if (!hasSourceItems) throw new AppError("Source locker is not attached to this order", 400);

    await tx.orderItem.updateMany({
      where: { orderId: order.id, lockerId: from.id },
      data: { lockerId: to.id, lockerNumber: to.number },
    });
    await tx.locker.update({ where: { id: from.id }, data: { status: "EMPTY", currentOrderId: null } });
    await tx.locker.update({ where: { id: to.id }, data: { status: order.status === "DELAYED" ? "DELAYED" : "BUSY", currentOrderId: order.id } });

    const result = await tx.order.findUnique({ where: { id: order.id }, include: { items: true } });
    await audit({
      tx,
      branchId: order.branchId,
      userId: user.id,
      entityType: "Order",
      entityId: order.id,
      action: "LOCKER_TRANSFER",
      oldValue: { fromLockerId: from.id, fromLockerNumber: from.number },
      newValue: { toLockerId: to.id, toLockerNumber: to.number },
      description: data.note || "Locker transferred",
    });
    telegram.sendSafely(telegram.sendLockerTransfer({ branchId: order.branchId, branch: order.branch, from: from.number, to: to.number, order: order.orderNumber, note: data.note, createdBy: user }), { branchId: order.branchId, userId: user.id, entityType: "Order", entityId: order.id });
    return result;
  });
};

module.exports = { listLockers, getLocker, setService, restore, transfer };
