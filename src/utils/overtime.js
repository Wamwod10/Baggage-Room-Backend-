const OVERTIME_GRACE_MINUTES = 10;
const OVERTIME_GRACE_MS = OVERTIME_GRACE_MINUTES * 60 * 1000;

const overtimeMsAfterGrace = (plannedCheckOut, actualTime = new Date()) => {
  if (!plannedCheckOut || !actualTime) return 0;
  const planned = plannedCheckOut instanceof Date ? plannedCheckOut : new Date(plannedCheckOut);
  const actual = actualTime instanceof Date ? actualTime : new Date(actualTime);
  if (Number.isNaN(planned.getTime()) || Number.isNaN(actual.getTime())) return 0;
  return Math.max(0, actual.getTime() - planned.getTime() - OVERTIME_GRACE_MS);
};

const isOverdueAfterGrace = (plannedCheckOut, actualTime = new Date()) =>
  overtimeMsAfterGrace(plannedCheckOut, actualTime) > 0;

const overtimeHoursAfterGrace = (plannedCheckOut, actualTime = new Date()) => {
  const diffMs = overtimeMsAfterGrace(plannedCheckOut, actualTime);
  return diffMs > 0 ? Math.max(1, Math.ceil(diffMs / 3600000)) : 0;
};

const overdueThresholdDate = (actualTime = new Date()) =>
  new Date(new Date(actualTime).getTime() - OVERTIME_GRACE_MS);

module.exports = {
  OVERTIME_GRACE_MINUTES,
  OVERTIME_GRACE_MS,
  overtimeMsAfterGrace,
  overtimeHoursAfterGrace,
  isOverdueAfterGrace,
  overdueThresholdDate,
};
