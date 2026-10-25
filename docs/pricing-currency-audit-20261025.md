# Pricing and currency audit ? 2026-10-25

Scope: main fc80ded (backend), ff1dc52 (frontend). Production data checked using BEGIN READ ONLY / ROLLBACK, restricted to the eight supplied order numbers and TJV tariff rows. No customer identity data exported. No orders, discounts, cash movements, shifts, Sheets, environment variables or migrations changed. Refunds require the existing approval workflow; this report does not authorize refunds.

## Root causes and fix

1. Manual duration pricing unconditionally used hours * price1h. New TJV manual durations strictly greater than 12 and at most 72 now use price12h + ceil(hours - 12) * price1h, per size/count. Existing <=12 behavior (including manual 12h), preset packages, other branches and >72 daily rates remain unchanged. New order snapshot customTariffRule identifies this rule for later size changes and foreign-currency overtime reconstruction; historical snapshots retain their original formula.
2. Confirmed interface/report defect: Analytics daily, branch and admin totals added native minor amounts from different currencies and rendered them with a UZS-only formatter. A USD payment of 13280 could become 13,280 UZS instead of 132.80 USD. Keep scalar UZS fields strictly UZS; expose native currency maps for branch/admin/dashboard summaries and format each currency once. Dashboard previously omitted foreign currencies from its maps. Original order cards, SalesHistory, receipts, Telegram, backend order responses and Sheets already retain/format minor units correctly; no reproduced 100x defect found in those order-detail paths. The user narrowed the symptom to cash/shift or another interface screen. Shift currency maps already divide correctly on main; that exact 100x cash-screen symptom was not reproduced from main. Shift headline cards now use native currency maps and CurrentShift uses the shared currency formatter (exactly two USD/RUB decimals), rather than a duplicate maximum-fraction-only formatter. Deployed bundle/session parity remains to be checked before claiming the exact observed screen is fixed.

Currency contract: DB, calculation, cash ledger, audit and Jarvis original monetary fields remain MINOR units: UZS factor 1; USD/RUB factor 100. Frontend/Telegram format once. Sheets backend payload carries amountUnit=MAJOR and original amountMinor, and Apps Script consumes the major value without dividing again. Jarvis serializers remain unchanged; consumers must format raw minor amounts according to currency. No live spreadsheet rows were modified or independently reconciled.

## Historical review list (no automatic edits/refunds)

| Order | Stored base / base paid | Correct base | Existing overtime | Ledger net received | Review difference |
| --- | ---: | ---: | ---: | ---: | ---: |
| TJV-005640 | 112000 UZS | 96000 UZS (2 S,14h) | 0 | 112000 UZS | 16000 UZS |
| TJV-005440 | 210000 UZS | 177000 UZS (2 S,1 M,15h) | 0 | 210000 UZS | 33000 UZS |
| TJV-005507 | 56000 UZS | 48000 UZS (1 S,14h) | 0 | 56000 UZS | 8000 UZS |
| TJV-005439 | 450000 UZS | 370000 UZS (1 M,3 L,15h selected) | 90000 UZS (3h) | 540000 UZS | 80000 UZS vs corrected 460000 total |

TJV pricing differences total 137000 UZS. TJV-005439 stored checkIn=2026-10-16T17:27:00Z, plannedCheckOut=2026-10-17T08:27:00Z, realPickupTime=2026-10-17T11:12:08.997Z. Selected tariffHours/customHours/items tariffHours all equal 15. Actual duration is 17h45m08.997s; three overtime hours were recorded. An 18h selection would yield 460000 UZS as base; that was not the saved selection. All four TJV discountAmount values remain zero.

| Order | Verified stored minor fields / ledger | Correct display and interpretation |
| --- | --- | --- |
| TIA-001060 | calculated/final/paid 214285 RUB | 2142.85 RUB |
| TIA-001006 | calculated 13280 USD; discount 6280; final/paid/ledger 7000 | calculated 132.80 USD; existing discount 62.80 USD; paid 70.00 USD. Preserve recorded discount. |
| TIA-001013 | base/paid 57143 RUB + overtime/ledger 28572 | total receipts 85715 minor = 857.15 RUB (571.43 + 285.72), not its base price |
| TIA-001028 | calculated/final 7360 USD; paid/ledger net 10000; paymentDifference 2640 | price 73.60 USD; receipts 100.00 USD; separate 26.40 USD overpayment review. Ledger includes 8000 IN,8000 OUT,10000 IN. discountAmount remains zero. |

## Validation and limits

- New backend pricing/currency tests: 12 passing, including requested boundaries 1,12,13,14,15,24,48,72,73; fractional ceiling; size/count examples; unchanged branches/presets; quote conversion; historical/new foreign overtime; native report currency isolation.
- Backend full unit runner: 95/98 pass; three permission assertions fail identically on untouched main (83/86 pass). They predate this patch and conflict with main's staff-permission behavior. Not changed.
- Frontend runner: 28 passing. Jarvis: 14 passing, isolated DB test skipped because JARVIS_TEST_DATABASE_URL is absent. No production mutation tests executed.
- Changed-file frontend lint: two existing CurrentShift hook errors (Date.now during render, synchronous state update in effect), reproduced on untouched main; no new lint errors.
- Builds: Prisma client generation and Vite production build verified locally, using existing dependencies. Local Node 24.11.1; backend declares Node 20.x.
- Legacy UZS charts now only contain UZS; native foreign totals remain available in currency maps/sections. Existing archived baggage-size totals lack currency identity; those historical aggregates cannot be safely repaired by rescaling and remain outside this patch.
- Branch pushes only; main merge and production deploy require a separate decision.
