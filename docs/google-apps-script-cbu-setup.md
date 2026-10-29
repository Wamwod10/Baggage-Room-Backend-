# Qonoq Baggage: Google Apps Script -> official CBU (no VPS, staging first)

Goal: Use Google's time-driven Apps Script and UrlFetchApp as a transport for
the **official Central Bank of Uzbekistan JSON**. Do not use GOOGLEFINANCE spot
rates; they are not the official CBU daily reference rate.

Source code: `scripts/googleCbuRelay.gs`. No Google Finance, paid market-rate API,
browser rates, customer data, or database credentials are used in this worker.

## One-time Google account setup (must be done by an authorized Google user)

1. Open https://script.google.com/home/projects/create in the trusted company's Google account.
   Create a standalone script named `Qonoq CBU Official Rates`.
Security — limit Google permissions: this repository includes
`scripts/googleCbuManifest.json`. In Google Apps Script, open **Project Settings**,
enable **Show appsscript.json manifest file in editor**, and copy its JSON into
the project's `appsscript.json`. This grants only external HTTP access and
management of this project's own time-driven triggers; **no Google Drive,
Gmail, Calendar or Sheets access is requested**. The account owner must still
review the Google authorization prompt. Google Apps Script automatically
manages scopes if you don't set this manifest, but the explicit manifest
makes them auditable.

2. Replace the editor's `Code.gs` contents with the contents of
   [scripts/googleCbuRelay.gs](../scripts/googleCbuRelay.gs). Save.
   **Do not also copy `googleCbuProbe.gs`** because both define `probeCbu`.
3. Select the `probeCbu` function and click **Run**. Google will require the
   account owner to authorize outgoing HTTP requests. Review the requested
   permissions before accepting. In **Executions**, success prints
   `GOOGLE_CBU_REACHABLE` with today's Asia/Tashkent date and 5 currencies.
   If this fails due to CBU access, stop: Google is not a valid intermediary.
4. Set up a **disposable staging** backend deployment from PR #7, including
   forward-only Prisma migrations on a dedicated test DB. Do NOT use production
   until the real connectivity and payment tests pass.
5. Generate a strong 32+ byte random shared secret. Put the same value into:
   - Backend staging private environment: `CBU_SYNC_SHARED_SECRET`.
   - In Google Apps Script **Project Settings -> Script properties**:
     `CBU_SYNC_SHARED_SECRET` (secret).
   - In the same Script Properties, set `CBU_SYNC_TARGET_URL` to
     `https://YOUR-APPROVED-STAGING-BACKEND/api/integrations/cbu-rate-sync`.
   Do not expose secrets in GitHub, ChatGPT, Sheets, URLs, logs or the frontend.
   Only trusted staff should have script editor access (editors may read Script Properties).
6. In Google Apps Script select `syncGoogleCbuRates` and click **Run**.
   Check **Executions** for `CBU_SYNC_OK` (not HTTP 401/409/503).
   The staging backend's `CbuRateInbox` should contain today's official JSON
   and the correct `fetchedAt`/date. The inbox migration is additive and must
   not backfill or update previous orders.
7. Set backend staging `CBU_RELAY_ENABLED=1` after confirming a successful
   signed push. Verify `GET /api/orders/exchange-rates` returns verified CBU
   rates, and test one synthetic 100 RUB and one synthetic 25 USD payment.
   Compare order detail, `CashMovement.fxRate/fxRateDate/uzsEquivalent`,
   Analytics, and Jarvis for the *same* official effective date.
8. For a **single-click staging activation**, once steps 1–5 and the staging
   backend are ready, select `activateGoogleCbuOnStaging` and press **Run**.
   It performs the Google-to-CBU probe, pushes one HMAC-signed staging snapshot,
   then installs the recurring 30-minute trigger **only if both succeed**.
   It can be disabled with `stopCbuTrigger`. This does **not** enable the
   production backend or deploy frontend code.

## Operational safety

- Consumer Apps Script accounts currently allow 20,000 URL Fetch calls/day.
  A successful 30-minute cycle needs about 2 calls (CBU + backend): ~96/day.
  Quotas vary/change; monitor failures in Google **Executions**.
- Fetches come from Google's server IP addresses. We cannot assume
  `cbu.uz` is reachable from Google; `probeCbu` is a required live check.
- Scripts must never silently fallback to GOOGLEFINANCE, an outdated mirror,
  or the previous RUB=89 browser setting.
- Source rates are verified for code, `Nominal`, positive decimal value,
  published date, nonfuture date, and at most one elapsed weekday of staleness;
  the backend performs validation again.
- Staging endpoint rejects invalid HMAC/timestamps and duplicate/older feed
  submissions. The worker reports an error and does not overwrite stored rates.
- Monitor trigger execution and paid/over-limit signals. Holidays may require
  a separately confirmed official CBU calendar policy; do not silently loosen
  freshness checks.
- On repeated failures stop the trigger and leave the production feature
  disabled. Production requires a documented backup, verified restore and
  deployment/revert procedure.
- Do not expose real customer or financial data in logs. This worker only
  processes public official CBU rates.

Official docs:
https://developers.google.com/apps-script/guides/services/quotas
https://developers.google.com/apps-script/reference/url-fetch
https://developers.google.com/apps-script/reference/script/clock-trigger-builder
https://cbu.uz/uz/arkhiv-kursov-valyut/veb-masteram/
