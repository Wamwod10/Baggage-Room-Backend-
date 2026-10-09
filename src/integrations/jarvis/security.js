const { createHash, timingSafeEqual, randomUUID } = require('node:crypto');
const rateLimit = require('express-rate-limit');

function loadConfig(env = process.env) {
  let keys;
  try { keys = JSON.parse(env.JARVIS_API_KEYS || '[]'); } catch { keys = []; }
  return { keys, rateLimit: Number(env.JARVIS_RATE_LIMIT_MAX || 120), windowMs: 60000 };
}

function validKeys(keys) {
  return Array.isArray(keys) && keys.length > 0 && keys.length <= 10
    && new Set(keys.map(key => key?.id)).size === keys.length
    && keys.every(key => key && /^[A-Za-z0-9_-]{1,40}$/.test(key.id)
      && /^[a-f0-9]{64}$/.test(key.hash)
      && (!key.expiresAt || (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(key.expiresAt) && Number.isFinite(Date.parse(key.expiresAt)))));
}

function defaultAuditSink(event) { process.stdout.write(JSON.stringify({ integration: 'jarvis', ...event }) + '\n'); }

function auditMiddleware(sink = defaultAuditSink) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    req.jarvisRequestId = randomUUID();
    res.setHeader('X-Request-ID', req.jarvisRequestId);
    res.setHeader('Cache-Control', 'no-store');
    res.once('finish', () => {
      const event = {
        requestId: req.jarvisRequestId, keyId: req.jarvisKeyId || null,
        endpoint: req.jarvisEndpoint || 'unknown', status: res.statusCode,
        durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1000000),
        createdAt: new Date().toISOString(),
      };
      // Never forward sink errors: arbitrary sink error messages may contain secrets.
      try { Promise.resolve(sink(event)).catch(() => process.stderr.write('Jarvis audit sink failed\n')); }
      catch { process.stderr.write('Jarvis audit sink failed\n'); }
    });
    next();
  };
}

function authenticate(config) {
  return (req, res, next) => {
    if (!validKeys(config.keys)) return res.status(503).json({ success: false, error: { code: 'INTEGRATION_DISABLED', message: 'Jarvis authentication is not configured' }, requestId: req.jarvisRequestId });
    const raw = req.headers['x-api-key'];
    const supplied = typeof raw === 'string' && raw.length >= 32 && raw.length <= 512;
    const digest = createHash('sha256').update(supplied ? raw : '').digest();
    let match;
    for (const key of config.keys) {
      const equal = timingSafeEqual(digest, Buffer.from(key.hash, 'hex'));
      if (equal && supplied && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now())) match = key;
    }
    if (!match) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Valid X-API-Key required' }, requestId: req.jarvisRequestId });
    req.jarvisKeyId = match.id;
    next();
  };
}

function limiter(config) {
  const max = Number.isInteger(config.rateLimit) && config.rateLimit > 0 && config.rateLimit <= 10000 ? config.rateLimit : 120;
  return rateLimit({
    windowMs: config.windowMs || 60000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Retry after the rate-limit window' }, requestId: req.jarvisRequestId }),
  });
}

module.exports = { loadConfig, auditMiddleware, authenticate, limiter };
