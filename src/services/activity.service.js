const prisma = require("../config/prisma");

const audit = async ({
  tx = prisma,
  branchId = null,
  userId = null,
  entityType,
  entityId,
  action,
  oldValue = null,
  newValue = null,
  description = null,
}) => {
  return tx.auditLog.create({
    data: { branchId, userId, entityType, entityId, action, oldValue, newValue, description },
  });
};

module.exports = { audit };
