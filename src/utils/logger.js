const write = (stream, level, message, meta) => {
  const payload = {
    level,
    message,
    ...(meta ? { meta } : {}),
    at: new Date().toISOString(),
  };
  stream.write(`${JSON.stringify(payload)}\n`);
};

const logger = {
  info: (message, meta) => write(process.stdout, "info", message, meta),
  warn: (message, meta) => write(process.stderr, "warn", message, meta),
  error: (message, meta) => write(process.stderr, "error", message, meta),
};

module.exports = logger;
