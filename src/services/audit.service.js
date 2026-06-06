const prisma = require("../config/prisma");
const { branchWhere } = require("../utils/scope");
const { dateRangeWhere } = require("../utils/date");
const { paginated } = require("../utils/pagination");

const listAuditLogs = async (user, query) => {
  const where = { ...branchWhere(user, query.branchId), ...dateRangeWhere(query.dateFrom, query.dateTo), ...(query.entityType ? { entityType: query.entityType } : {}), ...(query.action ? { action: query.action } : {}) };
  return paginated(prisma.auditLog, {
    where,
    include: { branch: { select: { id: true, name: true } }, user: { select: { id: true, name: true, login: true } } },
    orderBy: { createdAt: "desc" },
    query,
  });
};

module.exports = { listAuditLogs };
