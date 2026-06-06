const generateOrderNumber = async (tx, branchCode) => {
  const prefix = `${branchCode}-`;
  const last = await tx.order.findFirst({
    where: { orderNumber: { startsWith: prefix } },
    orderBy: { createdAt: "desc" },
    select: { orderNumber: true },
  });
  const lastNumber = last ? Number(last.orderNumber.replace(prefix, "")) || 0 : 0;
  return `${prefix}${String(lastNumber + 1).padStart(6, "0")}`;
};

module.exports = { generateOrderNumber };
