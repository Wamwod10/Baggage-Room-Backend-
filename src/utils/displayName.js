const KNOWN_BRANCH_NAMES = [
  "Toshkent xalqaro aeroport",
  "Toshkent aeroport",
  "Toshkent Shimoliy vokzal",
  "Toshkent Janubiy vokzal",
  "Samarqand vokzal",
  "Samarqand xalqaro aeroport",
  "Samarqand aeroport",
];

const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

const isLikelyDatabaseId = (value = "") => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return /^c[a-z0-9]{20,}$/i.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(trimmed);
};

const cleanDisplayText = (value, fallback = "-") => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  if (typeof value === "string" && isLikelyDatabaseId(value)) return fallback;
  return value;
};

const branchNameCandidates = (branch) => {
  if (!branch) return [];
  if (typeof branch === "string") return [branch];
  return [branch.name, branch.title, branch.displayName].filter(Boolean);
};

const isBranchDisplayName = (value, branch = null) => {
  const text = normalize(value);
  if (!text) return false;
  return [...branchNameCandidates(branch), ...KNOWN_BRANCH_NAMES]
    .map(normalize)
    .filter(Boolean)
    .includes(text);
};

const formatAdminName = (user, { branch = null, fallback = "-" } = {}) => {
  if (!user) return fallback;

  if (typeof user !== "object") {
    const value = cleanDisplayText(user, fallback);
    return isBranchDisplayName(value, branch) ? fallback : value;
  }

  const effectiveBranch = branch || user.branch || null;
  const candidates = [user.name, user.fullName, user.adminName, user.login];
  for (const candidate of candidates) {
    const value = cleanDisplayText(candidate, "");
    if (!value || isBranchDisplayName(value, effectiveBranch)) continue;
    return value;
  }
  return fallback;
};

module.exports = {
  cleanDisplayText,
  formatAdminName,
  isBranchDisplayName,
};
