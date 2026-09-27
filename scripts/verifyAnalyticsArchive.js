const fs = require("node:fs");

const volatileKeys = new Set(["timing", "cache", "generatedAt", "requestId"]);
const sensitiveKeys = new Set(["clientName", "phone", "passport", "note", "orderNumber", "password", "token", "secret"]);

const normalizeValue = (value, path = "root") => {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeValue(item, `${path}[${index}]`))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (sensitiveKeys.has(key)) throw new Error(`Sensitive field is not allowed in verification snapshots: ${path}.${key}`);
    if (volatileKeys.has(key)) continue;
    normalized[key] = normalizeValue(value[key], `${path}.${key}`);
  }
  return normalized;
};

const normalizeAnalyticsSnapshot = (value) => normalizeValue(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const verifyArchiveSnapshots = (beforeInput, afterInput, { archivedCount } = {}) => {
  const before = normalizeAnalyticsSnapshot(beforeInput);
  const after = normalizeAnalyticsSnapshot(afterInput);
  const errors = [];
  if (!same(before.analytics, after.analytics)) errors.push("analytics_changed");
  if (!same(before.activeOrders, after.activeOrders)) errors.push("active_orders_changed");
  if (!same(before.lockers, after.lockers)) errors.push("locker_state_changed");
  const expectedAfterTotal = Number(before.salesHistoryTotal) - Number(archivedCount);
  if (Number(after.salesHistoryTotal) !== expectedAfterTotal) errors.push("sales_history_delta_mismatch");
  return { ok: errors.length === 0, errors };
};

const parseArgs = (argv = process.argv.slice(2)) => {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--([^=]+)=(.+)$/);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    values[match[1]] = match[2];
  }
  const archivedCount = Number(values["archived-count"] || 5000);
  if (!values.before || !values.after) throw new Error("--before and --after snapshot paths are required");
  if (!Number.isInteger(archivedCount) || archivedCount < 1) throw new Error("--archived-count must be a positive integer");
  return { before: values.before, after: values.after, archivedCount };
};

const main = () => {
  const args = parseArgs();
  const before = JSON.parse(fs.readFileSync(args.before, "utf8"));
  const after = JSON.parse(fs.readFileSync(args.after, "utf8"));
  const result = verifyArchiveSnapshots(before, after, { archivedCount: args.archivedCount });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { normalizeAnalyticsSnapshot, verifyArchiveSnapshots, parseArgs, main };
