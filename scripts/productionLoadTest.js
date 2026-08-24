/*
 * Safe, read-only production-readiness load test.
 *
 * Required for authenticated data endpoints:
 *   LOAD_TEST_BASE_URL=https://staging.example.com
 *   LOAD_TEST_TOKEN=<short-lived operator token>
 *   LOAD_TEST_BRANCH_ID=<branch id>
 *
 * Defaults to 5 virtual users and 20 seconds. The script never prints the
 * token and only performs GET requests, so it cannot create or mutate data.
 */
const { performance } = require("node:perf_hooks");

const baseUrl = String(process.env.LOAD_TEST_BASE_URL || "http://127.0.0.1:5000")
  .trim()
  .replace(/\/+$/, "");
const token = String(process.env.LOAD_TEST_TOKEN || "").trim();
const branchId = String(process.env.LOAD_TEST_BRANCH_ID || "").trim();
const envInt = (name, fallback, min, max) => {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};
const virtualUsers = envInt("LOAD_TEST_VUS", 5, 1, 100);
const durationSeconds = envInt("LOAD_TEST_DURATION_SEC", 20, 1, 3600);
const timeoutMs = envInt("LOAD_TEST_TIMEOUT_MS", 15000, 500, 120000);
const thinkTimeMs = envInt("LOAD_TEST_THINK_MS", 250, 0, 60000);

const configuredEndpoints = String(process.env.LOAD_TEST_ENDPOINTS || "")
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);

const authenticatedEndpoints = branchId
  ? [
      "/api/branches",
      `/api/lockers?branchId=${encodeURIComponent(branchId)}`,
      `/api/orders?branchId=${encodeURIComponent(branchId)}&limit=50`,
      `/api/notifications?branchId=${encodeURIComponent(branchId)}&isRead=false&limit=20`,
      `/api/analytics/dashboard?branchId=${encodeURIComponent(branchId)}`,
    ]
  : [];

const endpoints = configuredEndpoints.length
  ? configuredEndpoints
  : ["/health", "/ready", ...(token ? authenticatedEndpoints : [])];

const samples = [];
const deadline = performance.now() + durationSeconds * 1000;

const request = async (path) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let status = 0;
  let error = null;

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    status = response.status;
    await response.arrayBuffer();
  } catch (requestError) {
    error = requestError?.name === "AbortError" ? "timeout" : "network_error";
  } finally {
    clearTimeout(timeout);
  }

  samples.push({
    path,
    status,
    ok: status >= 200 && status < 400,
    error,
    durationMs: performance.now() - startedAt,
  });
};

const runWorker = async () => {
  let cursor = 0;
  while (performance.now() < deadline) {
    await request(endpoints[cursor % endpoints.length]);
    cursor += 1;
    if (thinkTimeMs > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, thinkTimeMs));
    }
  }
};

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(2));
};

const summarize = (rows) => {
  const durations = rows.map((row) => row.durationMs);
  return {
    count: rows.length,
    errors: rows.filter((row) => !row.ok).length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    minMs: durations.length ? Number(Math.min(...durations).toFixed(2)) : null,
    maxMs: durations.length ? Number(Math.max(...durations).toFixed(2)) : null,
  };
};

if (!endpoints.length) {
  throw new Error("No load-test endpoints configured");
}

Promise.all(Array.from({ length: virtualUsers }, runWorker)).then(() => {
  const byEndpoint = Object.fromEntries(
    endpoints.map((path) => [path, summarize(samples.filter((row) => row.path === path))]),
  );

  process.stdout.write(`${JSON.stringify({
    target: baseUrl,
    virtualUsers,
    durationSeconds,
    timeoutMs,
    thinkTimeMs,
    endpoints,
    overall: summarize(samples),
    byEndpoint,
  }, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`Load test failed: ${error.message}\n`);
  process.exitCode = 1;
});
