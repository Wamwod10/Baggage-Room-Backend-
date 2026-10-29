# Google Finance-only exchange rates (STAGING; no CBU)

This replaces the earlier Google->CBU script. It never calls cbu.uz or a
third-party FX API. It uses **Google Sheets GOOGLEFINANCE** market quote pairs
for USD, EUR, RUB, KZT and TJS against UZS.

**Accuracy/licensing:** Google warns that quotes may be delayed up to 20 minutes
and that professional use may be subject to additional licensing fees. Google
does not provide a guaranteed live quote timestamp in the simple Sheets formula.
This is a **market price**, not an official CBU rate, bank cash exchange rate,
or verified settled quote. Do not use it to price production baggage receipts
before confirming that the terms allow this business use and that all five
currency formulas work in the user's Google account.

Official Google terms:
https://support.google.com/docs/answer/3093281
https://support.google.com/docs/answer/58515

## One-time Apps Script setup (user's own Google account)

1. Open the existing Apps Script project at https://script.google.com .
   **Replace the entire previous Code.gs contents** with
   [googleFinanceRelay.gs](../scripts/googleFinanceRelay.gs).
   Do NOT append after the old CBU code; that script is retired for this mode.
2. Optionally use the explicit least-privilege manifest:
   [googleFinanceManifest.json](../scripts/googleFinanceManifest.json)
   in the appsscript.json editor (Project Settings -> show manifest).
   It requests Google Sheets read/write access (to create the separate
   quotes spreadsheet), outgoing HTTPS and recurring trigger management.
   No Gmail or calendar scopes are required.
3. Save, choose `setupGoogleFinanceSheet`, click **Run**, and grant required
   Google permissions after reviewing them. This creates one dedicated
   private Google Sheet and fills five `GOOGLEFINANCE("CURRENCY:...UZS")`
   formulas. The Script Properties entry `GF_SHEET_ID` is created automatically.
4. Open **Executions** and copy the resulting `sheetUrl`. Inspect all five
   rows; wait briefly for Google Finance formulas to calculate.
   For KZT and TJS, if the direct Google Finance UZS quote is unavailable,
   the sheet attempts a **Google-only** derived rate using the currency/USD
   and USD/UZS quotes. This is a derived market rate, not a bank rate.
5. Select `probeGoogleFinance` and **Run**. Success must print
   source `GOOGLE_FINANCE` and FIVE positive numeric rates.
   If even one currency displays `#N/A` or another error, the probe
   refuses to send any rates. This is especially important for TJS/KZT.
   We do **not** substitute CBU or invent a rate.

## Staging server-side integration (not yet deployed)

A dedicated database migration `202610290001_google_finance_rate_inbox`
creates a separate `GoogleFinanceRateInbox` table. No old cash/order rows
are changed. Add environment variables on an **isolated staging backend**:
- `FX_RATE_PROVIDER=GOOGLE_FINANCE`
- `GOOGLE_FINANCE_SYNC_SECRET=<secure random 32+ byte secret>`

In Apps Script Project Settings -> Script Properties set:
- `GOOGLE_FINANCE_SYNC_URL=https://YOUR-APPROVED-STAGING-BACKEND/api/integrations/google-finance-sync`
- `GOOGLE_FINANCE_SYNC_SECRET=<same secure secret>`

Generate the secret in an administrator-approved secret manager, not in
source code, query strings or chat. Do not use the production Render URL
before staged tests and data licensing review.

Run `activateGoogleFinanceOnStaging` once: it checks all 5 formula cells,
pushes a signed current observation, confirms the staging acknowledgement,
and installs **one** 30-minute time-based trigger. `stopGoogleFinanceTrigger`
disables that trigger.

The server verifies an HMAC over the exact raw JSON, a five-minute request
window, 5 currency codes, positive decimal rates and newest observation.
It records the source as `GOOGLE_FINANCE`, sets the observation business
date in `fxRateDate`, and calculates new payment's UZS equivalent using
minor units. This date is NOT an official CBU effective date. It refuses
stale (>65min), missing, forged, duplicated or untrusted currency quotes.
In Google provider mode it **never falls back to CBU or a browser exchange rate**.
Older orders/ledger records are unchanged.

Before going live: verify the Google Sheet currency quotes are present and
licensed for the business, test synthetic 100 RUB and 25 USD order/payments
in a disposable staging database and reconcile with Jarvis and Analytics,
confirm backups/rollback, then only after approval deploy backend and frontend
together with operator monitoring.
