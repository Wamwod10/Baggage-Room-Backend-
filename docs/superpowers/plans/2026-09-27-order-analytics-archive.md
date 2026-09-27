# Order Analytics Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the deterministic oldest 5,000 raw orders from sales history while preserving their analytics contribution and reducing backend analytics work.

**Architecture:** Store non-PII daily/branch order facts in an aggregate archive, merge those facts with database-side live-order aggregates, and prune raw orders through a guarded serializable transaction. A bounded 30-second cache protects repeated analytics reads, while explicit invalidation keeps mutations visible.

**Tech Stack:** Node.js 20, CommonJS, Express 4, Prisma 6 with PostgreSQL, `node:test`, existing performance logger.

**Spec:** `docs/superpowers/specs/2026-09-27-order-analytics-archive-design.md`

## Global Constraints

- "First 5,000" means `Order` rows ordered by `createdAt ASC, id ASC` across all branches.
- Never archive an `ACTIVE`/`DELAYED` order, an order with an open debt, or an order referenced by `Locker.currentOrderId`; abort the whole run.
- Store no client name, phone, passport, note, order number, or raw order identity in analytics archive rows.
- Preserve existing whole-day Tashkent period semantics and existing analytics response fields.
- Preserve `CashMovement`, `Shift`, `Expense`, `Inkassa`, and `AuditLog` rows.
- Dry-run is the default; writes require `--execute`, an explicit run key, and the exact confirmation token for the unchanged selection hash.
- The destructive write is one serializable transaction and must be repeat-safe.
- Do not run production deletion without a provider snapshot and successful dry-run.

## Review Focus

- Two orders with identical `createdAt` values must still produce a stable selection and hash through the `id` tie-breaker (Task 4 test).
- A stale confirmation token after any candidate-set change must abort without writes (Task 4 test).
- Archive/live merging must not double-count an order at date or branch boundaries (Task 2 test).
- A selected order with a nullable financial relation must preserve the financial row while removing its order reference (Task 4 test).
- Cache entries for one branch must never be returned for another branch or date range (Task 3 test).

---

### Task 1: Archive fact model and pure aggregation contract

**Files:**
- Create: `src/services/orderAnalyticsFacts.js`
- Create: `test/orderAnalyticsFacts.test.js`
- Modify: `test/run.js`

**Interfaces:**
- Produces: `emptyOrderFacts() -> OrderFacts`
- Produces: `buildOrderFacts({ orders, debts }) -> Map<string, OrderFacts>`, keyed by `branchId|YYYY-MM-DD`
- Produces: `mergeOrderFacts(...facts) -> OrderFacts`
- Produces: `filterOrderFacts(rows, { branchId, dateFrom, dateTo }) -> OrderFacts[]`
- `OrderFacts` contains `totalOrders`, `statusCounts`, `hourCounts`, `sizeStats`, and `debtStats` with numeric leaves.

- [ ] **Step 1: Write failing pure-function tests**

Add tests named `buildOrderFacts buckets by Tashkent day and branch`, `buildOrderFacts preserves current status hour size and debt semantics`, `mergeOrderFacts sums without mutating inputs`, and `filterOrderFacts keeps inclusive whole-day boundaries`. Assert exact counts for two branches, midnight-crossing timestamps, duplicate item sizes, terminal statuses, and closed debt currencies. Assert serialized facts contain none of the PII field names from Global Constraints.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --require dotenv/config test/orderAnalyticsFacts.test.js`

Expected: FAIL because `../src/services/orderAnalyticsFacts` does not exist.

- [ ] **Step 3: Implement the pure fact functions**

Use `formatTashkentDateKey` and `getTashkentParts` from `src/utils/date.js`. Return fresh plain objects; normalize missing JSON keys and numeric strings to finite numbers. Preserve the current baggage-size meaning: each order-item row increments `orders` once, `count` by item count, and `amount` by final price.

- [ ] **Step 4: Run focused and full tests**

Run: `node --require dotenv/config test/orderAnalyticsFacts.test.js`

Expected: all new tests PASS.

Run: `npm test`

Expected: existing and new tests PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/services/orderAnalyticsFacts.js test/orderAnalyticsFacts.test.js test/run.js
git commit -m "feat: add archived order analytics facts"
```

### Task 2: Add archive schema and live/archive repository

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260927180000_add_order_analytics_archive/migration.sql`
- Create: `src/repositories/orderAnalytics.repository.js`
- Create: `test/orderAnalyticsRepository.test.js`
- Modify: `test/run.js`

**Interfaces:**
- Consumes: `OrderFacts` normalization and merge helpers from Task 1.
- Produces: `loadLiveOrderFacts(scope, client = prisma) -> Promise<OrderFacts[]>`
- Produces: `loadArchivedOrderFacts(scope, client = prisma) -> Promise<OrderFacts[]>`
- Produces: `loadCombinedOrderFacts(scope, client = prisma) -> Promise<OrderFacts>`
- Produces Prisma models `OrderAnalyticsArchive` and `OrderArchiveRun` exactly as specified in the design.

- [ ] **Step 1: Write failing schema and repository contract tests**

Test the wished-for repository with a fake injected client returning grouped live rows and archive rows. Assert `loadCombinedOrderFacts` merges branch/date-scoped data once. Add a schema contract assertion for the `(branchId, day)` unique key, `day` index, run primary key, selection hash, counts, boundaries, and execution timestamp.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --require dotenv/config test/orderAnalyticsRepository.test.js`

Expected: FAIL because the repository/models do not exist.

- [ ] **Step 3: Add the additive Prisma models and SQL migration**

Use JSON defaults of `{}` for count maps, integer default `0` for totals, a foreign key from archive rows to `Branch`, and no foreign key from `OrderArchiveRun` to raw orders. Keep the migration additive and safe on a populated database.

- [ ] **Step 4: Implement repository queries**

Use parameterized Prisma raw SQL for Tashkent `date`/hour grouping and the `OrderItem` join; never interpolate user input into SQL text. Apply branch and inclusive date predicates to both live and archive sources. Return only aggregate rows, not raw order records.

- [ ] **Step 5: Generate Prisma Client and verify**

Run: `npm run prisma:generate`

Expected: Prisma Client generation succeeds.

Run: `node --require dotenv/config test/orderAnalyticsRepository.test.js`

Expected: focused tests PASS.

Run: `npm test`

Expected: full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260927180000_add_order_analytics_archive src/repositories/orderAnalytics.repository.js test/orderAnalyticsRepository.test.js test/run.js
git commit -m "feat: add order analytics archive storage"
```

### Task 3: Integrate aggregated facts and bounded caching into analytics

**Files:**
- Create: `src/services/analyticsCache.js`
- Create: `test/analyticsCache.test.js`
- Modify: `src/services/analytics.service.js`
- Create: `test/analyticsArchiveIntegration.test.js`
- Modify: `test/run.js`

**Interfaces:**
- Consumes: `loadCombinedOrderFacts(scope, client)` from Task 2.
- Produces: `getCachedAnalytics(key)`, `setCachedAnalytics(key, value, branchId)`, and `invalidateAnalyticsCache(branchId?)`.
- Preserves: `dashboard(user, query)` and `reports(user, query)` public signatures and response fields.

- [ ] **Step 1: Write failing cache isolation tests**

Use an injectable clock. Assert a value expires after exactly 30 seconds, branch/date keys do not collide, cached objects cannot be mutated through callers, invalidating branch A preserves branch B, and global invalidation clears all entries.

- [ ] **Step 2: Run cache tests and verify RED**

Run: `node --require dotenv/config test/analyticsCache.test.js`

Expected: FAIL because `analyticsCache` does not exist.

- [ ] **Step 3: Implement the bounded cache**

Use a module-local `Map`, 30,000 ms TTL, deterministic keys containing role scope, effective branch, `dateFrom`, and `dateTo`, and a fixed maximum of 100 entries with oldest-entry eviction.

- [ ] **Step 4: Write failing analytics integration tests**

Inject live/archive facts and financial datasets into the analytics calculation boundary. Assert all-time, today, 7-day, 30-day, and one-branch results preserve total/status/day/hour/branch/size/debt fields. Assert revenue/payment/expense/inkassa/admin/shift fields are unchanged when archived order facts are introduced.

- [ ] **Step 5: Run integration tests and verify RED**

Run: `node --require dotenv/config test/analyticsArchiveIntegration.test.js`

Expected: FAIL because `analytics.service` still derives order metrics only from raw `findMany` arrays.

- [ ] **Step 6: Refactor analytics to consume combined facts**

Remove the reports query that loads every order with items. Replace order-derived loops and filters with combined facts. Change dashboard row-fetches used solely for counts to grouped/count queries. Wrap final `dashboard` and `reports` values with the cache and add `createTimer` steps named `live-order-facts`, `archive-order-facts`, and `analytics-merge`; log counts/timings only.

- [ ] **Step 7: Verify analytics tests and full suite**

Run: `node --require dotenv/config test/analyticsCache.test.js`

Run: `node --require dotenv/config test/analyticsArchiveIntegration.test.js`

Run: `npm test`

Expected: every command PASS with no warnings.

- [ ] **Step 8: Commit**

```bash
git add src/services/analyticsCache.js src/services/analytics.service.js test/analyticsCache.test.js test/analyticsArchiveIntegration.test.js test/run.js
git commit -m "perf: aggregate and cache analytics orders"
```

### Task 4: Guarded pruning service and dry-run CLI

**Files:**
- Create: `src/services/orderArchive.service.js`
- Create: `scripts/archiveOldOrders.js`
- Create: `test/orderArchive.test.js`
- Modify: `test/run.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 fact builder and Task 2 archive models.
- Produces: `buildArchivePlan({ client, runKey, limit }) -> Promise<ArchivePlan>`.
- Produces: `confirmationToken({ runKey, selectionHash }) -> string`.
- Produces: `executeArchivePlan({ client, runKey, limit, token }) -> Promise<ArchiveResult>`.
- `ArchivePlan` exposes only count/status/branch distributions, date boundaries, blockers, selection hash, and token; it exposes no PII or order IDs.

- [ ] **Step 1: Write failing plan/safety tests**

Assert stable oldest-first selection and identical hashes for equal timestamps, dry-run performs zero writes, and separate cases abort for `ACTIVE`, `DELAYED`, open debt, current locker, fewer than requested candidates, duplicate run key, stale token, and changed selection. Assert CLI parsing defaults to dry-run and rejects missing/invalid run key or limits outside `1..5000`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node --require dotenv/config test/orderArchive.test.js`

Expected: FAIL because the archive service/CLI do not exist.

- [ ] **Step 3: Implement read-only planning**

Select only fields needed for safety and aggregation, ordered by `createdAt ASC, id ASC`. Hash the ordered IDs plus timestamps internally with SHA-256, but never print IDs. Collect every blocker before returning the plan.

- [ ] **Step 4: Implement atomic execution**

Use a serializable Prisma transaction. Re-select and lock the candidates, compare the selection hash/token, build and upsert archive facts, null `CashMovement.orderId` and `Notification.relatedOrderId`, delete closed debts and order items, delete exactly the selected orders, assert live count dropped by `limit` and live-plus-archive count stayed constant, then insert `OrderArchiveRun`. Roll back on any mismatch.

- [ ] **Step 5: Add the CLI and package script**

Add `archive:orders` pointing to `node --require dotenv/config scripts/archiveOldOrders.js`. Print structured summaries without PII. Require both `--execute` and `--confirm=<token>` for writes; set a nonzero exit code for blockers or invariant failure.

- [ ] **Step 6: Run focused and full tests**

Run: `node --require dotenv/config test/orderArchive.test.js`

Expected: all archive tests PASS, including transaction rollback assertions.

Run: `npm test`

Expected: full suite PASS.

- [ ] **Step 7: Commit**

```bash
git add src/services/orderArchive.service.js scripts/archiveOldOrders.js test/orderArchive.test.js test/run.js package.json
git commit -m "feat: add guarded historical order pruning"
```

### Task 5: Invalidate analytics cache after successful mutations

**Files:**
- Modify: `src/services/order.service.js`
- Modify: `src/services/debt.service.js`
- Modify: `src/services/expense.service.js`
- Modify: `src/services/inkassa.service.js`
- Modify: `src/services/shift.service.js`
- Create: `test/analyticsInvalidation.test.js`
- Modify: `test/run.js`

**Interfaces:**
- Consumes: `invalidateAnalyticsCache(branchId?)` from Task 3.
- Preserves all mutation service public signatures.

- [ ] **Step 1: Write failing invalidation behavior tests**

For successful order create/update/pickup/cancel, scheduled ACTIVE-to-DELAYED transitions, debt close, expense create/delete, inkassa create, and shift open/close, assert affected-branch cache entries are invalidated after the transaction resolves. Assert failed transactions and idempotent replay paths do not clear unrelated branch entries.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --require dotenv/config test/analyticsInvalidation.test.js`

Expected: FAIL because mutation services do not invalidate analytics cache.

- [ ] **Step 3: Add post-success invalidation**

Call `invalidateAnalyticsCache(branchId)` only after each mutation has committed. Derive the branch from the committed result; do not perform cache operations inside database transactions.

- [ ] **Step 4: Run focused and full tests**

Run: `node --require dotenv/config test/analyticsInvalidation.test.js`

Run: `npm test`

Expected: all tests PASS with no warnings.

- [ ] **Step 5: Commit**

```bash
git add src/services/order.service.js src/services/debt.service.js src/services/expense.service.js src/services/inkassa.service.js src/services/shift.service.js test/analyticsInvalidation.test.js test/run.js
git commit -m "fix: invalidate analytics after mutations"
```

### Task 6: Verification tooling and local completion gate

**Files:**
- Create: `scripts/verifyAnalyticsArchive.js`
- Create: `test/verifyAnalyticsArchive.test.js`
- Modify: `test/run.js`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: `normalizeAnalyticsSnapshot(value) -> object`.
- Produces CLI `npm run archive:verify -- --before=<file> --after=<file>` that compares preserved analytics fields and operational invariants without secrets or PII.

- [ ] **Step 1: Write failing verifier tests**

Assert normalization ignores timing/cache metadata but detects changes in order totals, status/day/hour/branch/size/debt values, money values, active-order IDs/counts, and locker state. Assert it requires sales-history total to fall by exactly the requested archived count.

- [ ] **Step 2: Run verifier tests and verify RED**

Run: `node --require dotenv/config test/verifyAnalyticsArchive.test.js`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement verifier and operator documentation**

Document migration, test, snapshot, dry-run, confirmation, execution, verification, monitoring, and recovery commands. Ensure snapshot files and CLI output exclude tokens, credentials, and customer PII.

- [ ] **Step 4: Run all completion checks**

Run: `npm run prisma:generate`

Run: `npm test`

Run: `npm run db:readiness`

Expected: Prisma generation succeeds, all tests pass, and the local database readiness snapshot completes without error. If no safe local database is configured, report `db:readiness` as blocked rather than pointing it at production.

- [ ] **Step 5: Commit**

```bash
git add scripts/verifyAnalyticsArchive.js test/verifyAnalyticsArchive.test.js test/run.js package.json README.md
git commit -m "test: add analytics archive verification gate"
```

### Task 7: Production rollout and one-time archive run

**Files:**
- No source changes expected.
- Runtime evidence: provider snapshot identifier, migration/deploy result, redacted dry-run summary, confirmation token fingerprint, verification result, and performance timings.

**Interfaces:**
- Consumes the migration, CLIs, and verification contract from Tasks 1-6.
- Produces a verified production state with 5,000 fewer live orders and unchanged analytics facts.

- [ ] **Step 1: Run final pre-deploy checks**

Run `npm run prisma:generate` and `npm test` from `backend`; require clean PASS output. Inspect `git status --short` and ensure only intended changes exist.

- [ ] **Step 2: Deploy additive migration and archive-aware code**

Use the existing deployment workflow. Confirm `/health` and `/ready` return 200 and run authenticated analytics smoke checks before pruning.

- [ ] **Step 3: Capture protected before-state and provider snapshot**

Capture normalized analytics snapshots for all-time, today, 7-day, 30-day, and each branch; capture sales-history total, active-order count/IDs, and locker state. Create and record a provider database snapshot before any destructive command.

- [ ] **Step 4: Run and review production dry-run**

Run: `npm run archive:orders -- --run-key=initial-platform-orders-5000 --limit=5000`

Expected: `selectedCount=5000`, zero blockers, oldest/newest date boundaries, status/branch distributions, selection hash, and a confirmation token; no database writes and no PII in output.

- [ ] **Step 5: Execute the exact confirmed run once**

Run: `npm run archive:orders -- --run-key=initial-platform-orders-5000 --limit=5000 --execute --confirm=<exact-dry-run-token>`

Expected: one committed run, `liveDeleted=5000`, `archivedOrderCountDelta=5000` (the aggregate count, not archive-table row count), and unchanged combined total. Never rerun with a new run key to work around a blocker.

- [ ] **Step 6: Verify production invariants**

Capture the same after-state and run `npm run archive:verify`. Require unchanged normalized analytics/financial facts, sales-history total lower by exactly 5,000, and identical active-order and locker state.

- [ ] **Step 7: Observe performance and report**

Measure warm analytics dashboard/reports timings, compare them with the before-state, and inspect application/database errors. Report the provider snapshot recovery point, exact deleted/live/archive counts, verification result, and measured latency change without exposing PII.

