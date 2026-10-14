const { AppError } = require('../utils/response');
// No cached/operator boolean can substitute for the deployed script's read-only contract.
const assertReady = async (env = process.env, transport = fetch) => {
  if (env.FINANCE_APPROVAL_ENABLED !== 'true') throw new AppError('Financial approvals are disabled', 503);
  {
    let mapping;
    try { mapping = JSON.parse(env.FINANCE_TELEGRAM_APPROVERS || '{}'); } catch { /* Fail closed. */ }
    const ids = Object.keys(mapping || {}).sort();
    if (ids.join(',') !== '1043879955,523892896' || ids.some(id => typeof mapping[id] !== 'string' || !mapping[id].trim())) {
      throw new AppError('Production finance approver mapping is invalid', 503);
    }
  }
  const webhook = String(env.GOOGLE_SHEET_WEBHOOK || env.GOOGLE_SHEETS_WEBHOOK || '').trim();
  if ((env.GOOGLE_SHEETS_ENABLED || env.GOOGLE_SHEET_ENABLED) !== 'true' || !webhook) throw new AppError('Sheets financial readiness is unavailable', 503);
  try {
    const url = new URL(webhook);
    if (url.protocol !== 'https:') throw new Error();
    url.searchParams.set('action', 'FINANCE_CAPABILITIES');
    const response = await transport(url.toString(), { method: 'GET', signal: AbortSignal.timeout(8000) });
    const capability = await response.json();
    if (!response.ok || capability.ok !== true || capability.financeContract !== 'financial-operation-v1'
      || capability.columns !== 22 || capability.financialOperation !== true
      || capability.persistentIdempotency !== true || capability.selfTestPassed !== true) throw new Error();
  } catch { throw new AppError('Sheets financial readiness could not be verified', 503); }
  if (env.FINANCE_APPROVAL_ENABLED !== 'true') throw new AppError('Financial approvals are disabled', 503);
};
module.exports = { assertReady };
