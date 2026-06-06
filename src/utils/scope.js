const { AppError } = require("./response");

const getScopedBranchId = (user, requestedBranchId) => {
  if (user.role === "SUPER_ADMIN") return requestedBranchId || undefined;
  if (!user.branchId) throw new AppError("User is not assigned to a branch", 403);
  if (requestedBranchId && requestedBranchId !== user.branchId) {
    throw new AppError("You can access only your branch data", 403);
  }
  return user.branchId;
};

const branchWhere = (user, requestedBranchId) => {
  const branchId = getScopedBranchId(user, requestedBranchId);
  return branchId ? { branchId } : {};
};

module.exports = { getScopedBranchId, branchWhere };
