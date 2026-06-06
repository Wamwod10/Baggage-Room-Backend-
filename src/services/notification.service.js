const prisma = require("../config/prisma");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { AppError } = require("../utils/response");
const { paginated } = require("../utils/pagination");

const createNotification = async ({
  tx = prisma,
  branchId,
  type = "INFO",
  title,
  message,
  priority = 1,
  relatedOrderId = null,
}) => {
  return tx.notification.create({
    data: { branchId, type, title, message, priority, relatedOrderId },
  });
};

const listNotifications = async (user, query) => {
  return paginated(prisma.notification, {
    where: { ...branchWhere(user, query.branchId), ...(query.isRead !== undefined ? { isRead: query.isRead === "true" } : {}) },
    include: { relatedOrder: { select: { id: true, orderNumber: true, clientName: true } }, branch: { select: { id: true, name: true } } },
    orderBy: [{ isRead: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
    query,
  });
};

const markRead = async (user, id) => {
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) throw new AppError("Notification not found", 404);
  getScopedBranchId(user, notification.branchId);
  return prisma.notification.update({ where: { id }, data: { isRead: true } });
};

const markAllRead = async (user, body) => {
  const branchId = getScopedBranchId(user, body.branchId || user.branchId);
  const result = await prisma.notification.updateMany({ where: branchId ? { branchId } : {}, data: { isRead: true } });
  return { count: result.count };
};

module.exports = { createNotification, listNotifications, markRead, markAllRead };
