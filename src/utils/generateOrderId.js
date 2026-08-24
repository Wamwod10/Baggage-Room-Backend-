const generateOrderNumber = async (tx, branchCode) => {
  const prefix = `${branchCode}-`;
  // Serialize only order-number allocation for this branch. The lock is
  // transaction-scoped and prevents two operators from generating the same
  // number under concurrent creates without locking unrelated branches.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`order-number:${branchCode}`}))`;
  const last = await tx.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select: { orderNumber: true },
  });
  const lastNumber = last ? Number(last.orderNumber.replace(prefix, "")) || 0 : 0;
  return `${prefix}${String(lastNumber + 1).padStart(6, "0")}`;
};

module.exports = { generateOrderNumber };
