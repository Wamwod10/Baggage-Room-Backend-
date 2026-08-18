const isEnabled = () => /^(1|true|yes)$/i.test(String(process.env.PERF_LOG || ""));

const createTimer = (scope, meta = {}) => {
  if (!isEnabled()) {
    return {
      async time(_name, fn) {
        return fn();
      },
      end() {},
    };
  }

  const start = process.hrtime.bigint();
  const steps = [];
  const elapsedMs = (from) => Number(process.hrtime.bigint() - from) / 1e6;

  return {
    async time(name, fn) {
      const stepStart = process.hrtime.bigint();
      try {
        return await fn();
      } finally {
        steps.push({ name, ms: Math.round(elapsedMs(stepStart)) });
      }
    },
    end(extra = {}) {
      const totalMs = Math.round(elapsedMs(start));
      console.info(JSON.stringify({
        scope,
        totalMs,
        steps,
        ...meta,
        ...extra,
      }));
    },
  };
};

module.exports = { createTimer };
