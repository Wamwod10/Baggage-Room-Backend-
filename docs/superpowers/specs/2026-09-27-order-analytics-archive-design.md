# Order Analytics Archive and Backend Performance Design

## Context

The production database contains more than 11,000 orders. The sales-history page must stop exposing the first 5,000 orders created after the platform launched, while analytics must continue to report the same historical order counts and chart values. The current analytics implementation loads large collections of orders and their items into Node.js and aggregates them in memory, so its cost grows with the entire order history.

"First 5,000" has one deterministic meaning throughout this design: the first 5,000 rows from `Order` ordered by `createdAt ASC, id ASC`, across all branches.

## Goals

- Physically remove those 5,000 raw orders and their personally identifying order data from the operational order tables.
- Remove them from sales-history results and pagination totals.
- Preserve their contribution to every existing analytics period and branch filter.
- Reduce the amount of raw order data read by analytics and make repeated analytics requests inexpensive.
- Make the destructive operation atomic, repeat-safe, auditable, and impossible to run against unsafe operational orders.

## Non-goals

- The frontend UI and its visible filters do not change.
- Cash movements, shifts, expenses, inkassa, and audit records are not pruned.
- The archive is not a way to reopen, edit, search, or display a deleted order.
- Arbitrary timestamp-range analytics are not introduced. Existing analytics filters use whole Tashkent calendar days and remain supported.

## Chosen Approach

Use a daily aggregate archive, then physically delete raw order rows. Soft deletion would leave the operational tables and indexes large. Copying raw orders to another table would retain personal data and would not materially reduce total database size. Daily aggregates preserve the analytics facts with far fewer rows and no customer name, phone, passport, note, or order number.

## Data Model

Add `OrderAnalyticsArchive` with one row per Tashkent calendar day and branch:

- `id`
- `branchId`
- `day` (the Tashkent-local calendar date represented consistently in UTC)
- `totalOrders`
- `statusCounts` JSON keyed by `OrderStatus`
- `hourCounts` JSON keyed by Tashkent-local hour
- `sizeStats` JSON keyed by locker size, with `orders`, `count`, and `amount`
- `debtStats` JSON keyed by debt status and currency, preserving count and amount
- `createdAt` and `updatedAt`
- a unique constraint on `(branchId, day)` and an index on `day`

Add `OrderArchiveRun` to make the destructive operation auditable and repeat-safe:

- `key` as the primary key, supplied explicitly for the one-time run
- `selectionHash`, `selectedCount`, `firstCreatedAt`, and `lastCreatedAt`
- aggregate before/after counts
- `executedAt`

No raw customer or order identity data is stored in either archive table.

## Analytics Data Flow

Order analytics are split into two sources:

1. SQL aggregation over remaining live `Order` and `OrderItem` rows.
2. Matching daily rows from `OrderAnalyticsArchive`.

A focused merge module combines both sources for the requested date and branch scope. It produces the existing response shape for:

- total and per-status order counts;
- daily order counts;
- peak-hour counts;
- branch order, active, delayed, and cancelled counts;
- baggage-size order/count/amount metrics;
- archived debt count and amount metrics.

Revenue, payment, expense, inkassa, cash-on-hand, admin-performance, and shift metrics continue to use their existing financial source rows. `CashMovement` rows belonging to deleted orders are retained, so historical money totals do not change.

The dashboard uses the same merged order-summary module rather than counting only the live `Order` table. Sales history continues to query only `Order`; therefore its pagination total decreases by exactly 5,000 after a successful run.

## Performance Changes

- Replace analytics order `findMany(...items)` calls with database-side grouped queries that return only aggregated rows.
- Replace dashboard queries that fetch rows solely to count them with `count`/grouped queries.
- Run independent database aggregates in parallel.
- Add a bounded in-process analytics cache with a 30-second TTL, keyed by authenticated scope, branch, and date range. The frontend already refreshes analytics every 60 seconds, so this does not weaken its effective freshness.
- Clear relevant cache entries after order, debt, expense, inkassa, or shift mutations; TTL remains a fallback.
- Keep existing performance logging and add total timing for live aggregation, archive loading, and merge phases without logging customer data.

The archive merge is proportional to the number of day/branch buckets rather than the number of deleted orders.

## Pruning Command

Add a dedicated command with dry-run as its default behavior. It requires an explicit run key and limit, for example:

`npm run archive:orders -- --run-key=initial-platform-orders-5000 --limit=5000`

Dry-run:

- selects `createdAt ASC, id ASC` with a stable tie-breaker;
- prints only counts, status distribution, branch distribution, date boundaries, and a selection hash;
- never prints customer PII;
- reports all blockers and performs no writes;
- emits a confirmation token derived from the run key and selection hash.

Execution additionally requires `--execute` and that exact confirmation token. A unique `OrderArchiveRun.key` prevents the same archival run from deleting the next 5,000 orders if the command is repeated.

## Safety Preconditions

The entire operation aborts before writing if any selected order:

- has status `ACTIVE` or `DELAYED`;
- has an open debt;
- is referenced by `Locker.currentOrderId`;
- has a relation shape that the archival calculation cannot account for;
- differs from the dry-run selection hash;
- is not exactly the requested count;
- belongs to an already completed run key.

A provider database snapshot must exist before execution. The command does not silently weaken these checks to reach a count of 5,000.

## Atomic Execution

One serializable database transaction performs the following operations:

1. Re-select and lock the exact candidate set and verify its confirmation hash.
2. Calculate daily/branch order, status, hour, baggage-size, and closed-debt aggregates.
3. Upsert aggregate archive rows.
4. Set `CashMovement.orderId` and `Notification.relatedOrderId` to `NULL` for selected orders, preserving those historical rows.
5. Delete archived closed `Debt` rows and `OrderItem` rows.
6. Delete the selected `Order` rows.
7. Verify that live order count fell by 5,000 and live-plus-archive order count did not change.
8. Insert the immutable `OrderArchiveRun` record.

Any failure rolls back every step. Audit logs use string entity IDs rather than a foreign key and remain unchanged.

## Correctness and Verification

Tests cover:

- deterministic oldest-first selection when timestamps are equal;
- dry-run writes nothing;
- unsafe status, open debt, current locker, count mismatch, hash mismatch, and duplicate run key each abort;
- archive aggregation matches the current JavaScript analytics semantics, including baggage-size `orders` counting;
- live and archived daily facts merge correctly for all-time, 30-day, 7-day, today, and branch scopes;
- sales-history totals exclude archived orders;
- financial totals remain unchanged because cash movements remain;
- transaction failure leaves both operational and archive tables unchanged;
- cache keys isolate branches/date ranges and mutations invalidate affected entries.

Before executing against production, capture analytics responses for all supported periods and every branch. After execution, compare normalized analytics responses and require equality for all preserved historical metrics. Also verify that sales-history total is exactly 5,000 lower and that no active-order or locker state changed.

## Deployment Sequence

1. Apply the additive schema migration and deploy archive-aware analytics code.
2. Run the backend test suite and a production read-only analytics/load check.
3. Create a provider database snapshot.
4. Run the pruning command in dry-run mode and review its blockers, boundaries, distributions, and hash.
5. Execute once with the same run key and confirmation token.
6. Run the post-execution equality and operational-state checks.
7. Monitor performance timings and errors before considering database maintenance.

PostgreSQL can reuse deleted table space for future rows. A blocking `VACUUM FULL` is not part of this operation; it would require a separate maintenance window if physical file shrinkage is later necessary.

## Recovery

Before execution, rollback is simply not running the confirmed command. After execution, raw order recovery requires restoring the provider snapshot because the aggregate archive intentionally contains no PII or complete order records. If validation fails during the transaction, automatic rollback preserves the original database.
