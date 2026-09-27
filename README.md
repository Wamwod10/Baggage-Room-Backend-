# Baggage Room Management Backend

Production-ready Node.js + Express + PostgreSQL Neon + Prisma backend.

## Stack

- Node.js, Express.js
- PostgreSQL Neon
- Prisma ORM
- JWT Auth, bcrypt
- CORS, dotenv, Helmet, Morgan, express-rate-limit
- Zod validation

## Environment

Create `backend/.env`:

```env
DATABASE_URL="Neon pooled connection"
DIRECT_URL="Neon direct connection"
JWT_SECRET="strong secret"
JWT_EXPIRES_IN="7d"
PORT=5000
FRONTEND_URL="https://qonoqbaggage.uz,https://www.qonoqbaggage.uz"
SEED_PASSWORD="Admin@12345"
OVERDUE_JOB_ENABLED="true"
OVERDUE_JOB_INTERVAL_MS=300000
```

`FRONTEND_URL` can contain comma-separated origins.

## Google Sheets Webhook

Enable Google Sheets delivery with:

```env
GOOGLE_SHEETS_ENABLED=true
GOOGLE_SHEET_WEBHOOK="Google Apps Script Web App URL"
```

The Apps Script webhook template is in `scripts/googleSheetsAppsScript.js`.
It writes `NEW_ORDER`, `DOPLATA`, `EXPENSE`, `SALARY`, and `INKASSA` events
as exact 22-cell A:V rows. It does not use `appendRow()`, writes after the last
real data row, and skips duplicate events by `idempotencyKey`.
Month tabs are selected automatically from the event date in Asia/Tashkent time,
for example `Июль 2026`. The script only writes to an existing exact month tab;
it never falls back to the first/active sheet and never creates a month tab.

After changing the template, publish a new Apps Script Web App deployment
version. Check month tabs without writing rows with:

```bash
npm run test:sheets:months
```

Run the labeled live smoke test, which writes mapping test rows, with:

```bash
npm run test:sheets:real
```

## Local Run

```bash
npm install
npx prisma migrate dev
npm run seed
npm run dev
```

API base URL:

```txt
http://localhost:5000/api
```

## Render Deploy

Build command:

```bash
npm install && npx prisma generate && npx prisma migrate deploy
```

Start command:

```bash
npm start
```

Set the same environment variables in Render.

## Historical Order Archive

The archive command moves historical order facts into daily branch aggregates and
then removes the corresponding closed orders from live sales history. Run it only
after the additive Prisma migration and archive-aware application code have been
deployed.

1. Create a database-provider snapshot and record its recovery identifier.
2. Run the local gates against a safe non-production database:

```bash
npm run prisma:generate
npm test
npm run db:readiness
```

3. Capture a redacted `before.json` containing `analytics`, `salesHistoryTotal`,
   `activeOrders`, and `lockers`. Include all-time, today, 7-day, 30-day, and
   per-branch analytics in `analytics`. Store only IDs and state needed for the
   invariants; never include names, phone numbers, passports, notes, order
   numbers, tokens, credentials, or other customer PII.
4. Preview the deterministic oldest 5,000 eligible orders. This is read-only:

```bash
npm run archive:orders -- --run-key=initial-platform-orders-5000 --limit=5000
```

Continue only when `selectedCount` is 5,000 and `blockers` is empty. Review the
date boundaries, status and branch distributions, selection hash, and keep the
returned confirmation token private.

5. Execute the exact reviewed selection once:

```bash
npm run archive:orders -- --run-key=initial-platform-orders-5000 --limit=5000 --execute --confirm=<exact-dry-run-token>
```

Do not retry with a different run key if execution is blocked. Investigate the
blocker first.

6. Capture the same redacted fields as `after.json`, then verify the result:

```bash
npm run archive:verify -- --before=before.json --after=after.json --archived-count=5000
```

The verifier must return `"ok": true`: analytics, active orders, and locker state
must be unchanged, while the live sales-history total must be exactly 5,000 lower.
Monitor `/health`, `/ready`, analytics latency, application errors, and database
errors after execution.

If verification fails, stop writes and restore the recorded provider snapshot.
Redeploy the previously known-good application version, rerun the same redacted
checks, and retain the failed run's redacted logs for diagnosis.

## Default Seed Logins

Password for all default users defaults to:

```txt
Admin@12345
```

You can override it with `SEED_PASSWORD`.

## Money Amounts

All money values are stored as integer minor units:

- UZS: `20000` = 20,000 UZS
- USD/EUR/RUB: `150` = 1.50

Frontend should send integer minor units for every amount and price field.

## Overdue Baggage Job

The server runs an overdue baggage job every 5 minutes by default. It marks active overdue orders as `DELAYED`, updates lockers to `DELAYED`, creates one notification, and sends Telegram alerts when enabled.

- `rahbariyat` - SUPER_ADMIN
- `toshkent_airport` - Тошкент халкаро аэропорт
- `toshkent_shimoliy` - Тошкент Шимолий вокзал
- `toshkent_janubiy` - Тошкент Жанубий вокзал
- `samarqand_vokzal` - Самарканд вокзал
- `samarqand_airport` - Самарканд халкаро аэропорт

## Endpoints

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/branches`
- `GET /api/users`
- `POST /api/users`
- `PATCH /api/users/:id`
- `GET /api/lockers`
- `GET /api/lockers/:id`
- `PATCH /api/lockers/:id/service`
- `PATCH /api/lockers/:id/restore`
- `POST /api/lockers/transfer`
- `GET /api/orders`
- `GET /api/orders/:id`
- `POST /api/orders`
- `PATCH /api/orders/:id`
- `POST /api/orders/:id/pickup`
- `POST /api/orders/:id/cancel`
- `GET /api/debts`
- `POST /api/debts/:id/close`
- `GET /api/shifts`
- `GET /api/shifts/current`
- `POST /api/shifts/open`
- `POST /api/shifts/:id/close`
- `GET /api/expenses`
- `POST /api/expenses`
- `GET /api/inkassa`
- `POST /api/inkassa`
- `GET /api/cash-movements`
- `GET /api/tariffs`
- `PATCH /api/tariffs/:id`
- `GET /api/notifications`
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/read-all`
- `GET /api/telegram/settings`
- `PATCH /api/telegram/settings/:branchId`
- `POST /api/telegram/test/:branchId`
- `GET /api/analytics/dashboard`
- `GET /api/analytics/reports`
- `GET /api/export/orders`
- `GET /api/export/shifts`
- `GET /api/export/finance`
- `GET /api/audit`
