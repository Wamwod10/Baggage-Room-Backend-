require("dotenv").config();

const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { normalizeDatabaseUrl } = require("../src/utils/databaseUrl");

const adapter = new PrismaPg({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
});

const prisma = new PrismaClient({
  adapter,
});

const branches = [
  { name: "Тошкент халкаро аэропорт", code: "TIA", login: "toshkent_airport" },
  { name: "Тошкент Шимолий вокзал", code: "TSV", login: "toshkent_shimoliy" },
  { name: "Тошкент Жанубий вокзал", code: "TJV", login: "toshkent_janubiy" },
  { name: "Самарканд вокзал", code: "SVK", login: "samarqand_vokzal" },
  { name: "Самарканд халкаро аэропорт", code: "SIA", login: "samarqand_airport" },
];

const defaultPassword = process.env.SEED_PASSWORD || "Admin@12345";

const regularLockers = {
  S: [1, 4, 5, 6, 9, 13, 14, 15, 16, 17, 18],
  M: [2, 3, 7, 8, 11, 12, 19, 20],
  L: [10, 21],
};

const airportLockers = {
  S: [29, 30, 31, 36, 37, 38, 39, 40, 41, 42, 43, 44],
  M: [
    ...Array.from({ length: 10 }, (_, i) => i + 1),
    ...Array.from({ length: 8 }, (_, i) => i + 12),
    ...Array.from({ length: 8 }, (_, i) => i + 21),
    32,
    33,
    34,
    35,
  ],
  L: [11, 20],
};

const airportTariffs = {
  S: { price1h: 20000, price12h: 100000, price24h: 160000, price48h: 240000, price72h: 300000, after72hPrice: 100000 },
  M: { price1h: 30000, price12h: 120000, price24h: 200000, price48h: 300000, price72h: 380000, after72hPrice: 120000 },
  L: { price1h: 40000, price12h: 180000, price24h: 300000, price48h: 450000, price72h: 550000, after72hPrice: 180000 },
};

const stationTariffs = {
  S: { price1h: 4000, price12h: 40000, price24h: 75000, price48h: 120000, price72h: 180000, after72hPrice: 30000 },
  M: { price1h: 6000, price12h: 55000, price24h: 100000, price48h: 160000, price72h: 240000, after72hPrice: 40000 },
  L: { price1h: 8000, price12h: 75000, price24h: 140000, price48h: 240000, price72h: 360000, after72hPrice: 50000 },
};

const samAirportTariffs = {
  S: { price1h: 20000, price12h: 100000, price24h: 150000, price48h: 200000, price72h: 250000, after72hPrice: 30000 },
  M: { price1h: 30000, price12h: 150000, price24h: 250000, price48h: 300000, price72h: 400000, after72hPrice: 40000 },
  L: { price1h: 40000, price12h: 200000, price24h: 300000, price48h: 400000, price72h: 500000, after72hPrice: 50000 },
};

const tariffForBranch = (code) => {
  if (code === "TIA") return airportTariffs;
  if (code === "SIA") return samAirportTariffs;
  return stationTariffs;
};

const lockersForBranch = (code) => (code === "TIA" ? airportLockers : regularLockers);

const seedLockers = async (branch) => {
  const lockers = lockersForBranch(branch.code);
  for (const [size, numbers] of Object.entries(lockers)) {
    for (const number of numbers) {
      await prisma.locker.upsert({
        where: { branchId_number: { branchId: branch.id, number } },
        update: { size },
        create: { branchId: branch.id, number, size, status: "EMPTY" },
      });
    }
  }
};

const main = async () => {
  const passwordHash = await bcrypt.hash(defaultPassword, 12);

  await prisma.user.upsert({
    where: { login: "rahbariyat" },
    update: { name: "Rahbariyat", passwordHash, role: "SUPER_ADMIN", branchId: null, isActive: true },
    create: { login: "rahbariyat", name: "Rahbariyat", passwordHash, role: "SUPER_ADMIN" },
  });

  for (const item of branches) {
    const branch = await prisma.branch.upsert({
      where: { code: item.code },
      update: { name: item.name, isActive: true },
      create: { name: item.name, code: item.code },
    });

    await prisma.user.upsert({
      where: { login: item.login },
      update: { name: item.name, passwordHash, role: "BRANCH_ADMIN", branchId: branch.id, isActive: true },
      create: { login: item.login, name: item.name, passwordHash, role: "BRANCH_ADMIN", branchId: branch.id },
    });

    await prisma.telegramSetting.upsert({
      where: { branchId: branch.id },
      update: {},
      create: { branchId: branch.id },
    });

    await seedLockers(branch);

    const tariffs = tariffForBranch(branch.code);
    for (const [size, data] of Object.entries(tariffs)) {
      await prisma.tariff.upsert({
        where: { branchId_size: { branchId: branch.id, size } },
        update: data,
        create: { branchId: branch.id, size, ...data },
      });
    }
  }

  process.stdout.write("\nSeed completed. Default logins:\n");
  process.stdout.write(`SUPER_ADMIN: rahbariyat / ${defaultPassword}\n`);
  for (const branch of branches) {
    process.stdout.write(`BRANCH_ADMIN: ${branch.login} / ${defaultPassword} (${branch.name})\n`);
  }
};

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
