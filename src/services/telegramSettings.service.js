const prisma = require("../config/prisma");
const { AppError } = require("../utils/response");
const { branchWhere, getScopedBranchId } = require("../utils/scope");
const { audit } = require("./activity.service");
const telegram = require("./telegram.service");

const listSettings = async (user, query) => {
  return prisma.telegramSetting.findMany({
    where: branchWhere(user, query.branchId),
    include: { branch: { select: { id: true, name: true, code: true } } },
    orderBy: { branch: { name: "asc" } },
  });
};

const updateSettings = async (user, branchId, body) => {
  if (user.role !== "SUPER_ADMIN") throw new AppError("Only super admin can update Telegram settings", 403);
  const oldValue = await prisma.telegramSetting.findUnique({ where: { branchId } });
  const nextBotToken = body.botToken !== undefined ? body.botToken : oldValue?.botToken;
  const nextGroupId = body.groupId !== undefined ? body.groupId : oldValue?.groupId;
  if (body.enabled && (!String(nextBotToken || "").trim() || !String(nextGroupId || "").trim())) {
    throw new AppError("botToken and groupId are required when Telegram is enabled", 400);
  }
  const updated = await prisma.telegramSetting.upsert({
    where: { branchId },
    create: { branchId, ...body },
    update: body,
  });
  await audit({ branchId, userId: user.id, entityType: "TelegramSetting", entityId: updated.id, action: "TELEGRAM_SETTINGS_UPDATE", oldValue, newValue: updated, description: "Telegram settings updated" });
  return updated;
};

const testSend = async (user, branchId) => {
  getScopedBranchId(user, branchId);
  return telegram.testSend(branchId);
};

module.exports = { listSettings, updateSettings, testSend };
