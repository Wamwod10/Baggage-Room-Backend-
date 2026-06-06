const normalizeDatabaseUrl = (value) => {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.searchParams.delete("channel_binding");
    if (!url.searchParams.get("sslmode") || url.searchParams.get("sslmode") === "require") {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return value;
  }
};

module.exports = { normalizeDatabaseUrl };
