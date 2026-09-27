const prisma = require("../src/config/prisma");
const { buildArchivePlan, executeArchivePlan } = require("../src/services/orderArchive.service");

const parseArgs = (argv = process.argv.slice(2)) => {
  const values = {};
  for (const argument of argv) {
    if (argument === "--execute") values.execute = true;
    else if (argument.startsWith("--run-key=")) values.runKey = argument.slice("--run-key=".length);
    else if (argument.startsWith("--limit=")) values.limit = Number(argument.slice("--limit=".length));
    else if (argument.startsWith("--confirm=")) values.confirm = argument.slice("--confirm=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(values.runKey || "")) throw new Error("A valid --run-key is required");
  if (!Number.isInteger(values.limit) || values.limit < 1 || values.limit > 5000) throw new Error("--limit must be an integer from 1 to 5000");
  if (values.execute && !values.confirm) throw new Error("--confirm is required with --execute");
  return { runKey: values.runKey, limit: values.limit, execute: Boolean(values.execute), confirm: values.confirm || null };
};

const main = async () => {
  const args = parseArgs();
  const result = args.execute
    ? await executeArchivePlan({ client: prisma, runKey: args.runKey, limit: args.limit, token: args.confirm })
    : await buildArchivePlan({ client: prisma, runKey: args.runKey, limit: args.limit });
  console.log(JSON.stringify(result, null, 2));
  if (!args.execute && result.blockers.length) process.exitCode = 2;
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(JSON.stringify({ success: false, message: error.message, blockers: error.blockers || [] }, null, 2));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { parseArgs, main };
