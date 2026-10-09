const express = require('express');
const { loadConfig, auditMiddleware, authenticate, limiter } = require('./security');
const { parseQuery, FILTERS, JarvisError } = require('./query');

function createJarvisRouter({ client, config = loadConfig(), auditSink, getData } = {}) {
  const router = express.Router({ caseSensitive: true });
  const endpoints = new Set([...Object.keys(FILTERS), 'openapi.json']);
  router.use(auditMiddleware(auditSink));
  router.use((req, _res, next) => {
    const name = req.path.replace(/^\//, '').replace(/\/$/, '');
    req.jarvisEndpoint = endpoints.has(name) ? name : 'unknown';
    next();
  });
  router.use(limiter(config));
  router.use((req, res, next) => {
    if (req.method !== 'GET') return res.set('Allow', 'GET').status(405).json({ success: false, error: { code: 'READ_ONLY', message: 'Only GET is supported' }, requestId: req.jarvisRequestId });
    next();
  });
  router.use(authenticate(config));
  router.get('/openapi.json', (req, res, next) => {
    try {
      if (Object.keys(req.query).length) throw new JarvisError(400, 'INVALID_FILTER', 'OpenAPI accepts no filters');
      res.json(require('./openapi.json'));
    } catch (error) { next(error); }
  });
  for (const endpoint of Object.keys(FILTERS)) {
    router.get('/' + endpoint, async (req, res, next) => {
      try {
        const filters = parseQuery(req.query, endpoint);
        const read = getData || require('./repository').getJarvisData;
        const result = await read(client, endpoint, filters);
        res.json({ success: true, ...result, timezone: 'Asia/Tashkent', requestId: req.jarvisRequestId });
      } catch (error) { next(error); }
    });
  }
  router.use((req, res) => res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown Jarvis endpoint' }, requestId: req.jarvisRequestId }));
  router.use((error, req, res, _next) => {
    const known = error instanceof JarvisError;
    res.status(known ? error.status : 503).json({ success: false, error: { code: known ? error.code : 'DATA_UNAVAILABLE', message: known ? error.message : 'Integration data temporarily unavailable' }, requestId: req.jarvisRequestId });
  });
  return router;
}

module.exports = { createJarvisRouter };
