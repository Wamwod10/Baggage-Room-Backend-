# Optional signed domestic CBU rate sync (NOT deployed)

CBU direct HTTPS calls currently time out from Render Frankfurt and Singapore. This
allows an **owned Uzbekistan-hosted** scheduled worker to retrieve `cbu.uz` official
JSON rates and push five validated currencies to the backend, without passing
customer data or exposing database access. The backend accepts only HMAC-signed
payloads and stores them separately from existing orders. It will never guess a
rate, use a third-party quote or recalculate historic payments.

1. Apply migration **only in an approved staging release**.
2. Generate a strong random (at least 32-byte) shared secret in a secret manager.
   Configure `CBU_SYNC_SHARED_SECRET` on backend + the trusted domestic worker.
   Never commit it, put it in a URL or show it in logs.
3. Set backend `CBU_RELAY_ENABLED=1` only after a successful signed sync in staging.
4. On the domestic worker set `CBU_SYNC_TARGET_URL=https://<approved-backend>/api/integrations/cbu-rate-sync`.
   Run `node scripts/cbuDomesticSync.js` every 30 minutes via systemd timer,
   cron or Windows Task Scheduler. Must have outbound HTTPS access to cbu.uz.
5. Verify 5 official currencies, `Nominal` and effective `Date`. Server
   rejects incorrect signatures, unknown currency, future-dated or over-7-day-old
   publications. Inbox needs a successful update within 26 hours (including
   weekends/holidays) or foreign payment creation fails closed.
6. Confirm test payments and Jarvis reconciliation before production rollout.

This is a **pending integration design** until a domestic host and secure
deployment process have been provisioned. No production rate is accepted from
a user-provided browser value. The CBU does not digitally sign these API rows:
trust in their origin depends on the owned worker's HTTPS connection and the
HMAC-secured transport to the backend.

## Turnkey Ubuntu systemd installation (trusted Uzbekistan host)

The repository contains:
- `deploy/cbu-sync/qonoq-cbu-sync.service`
- `deploy/cbu-sync/qonoq-cbu-sync.timer`
- `deploy/cbu-sync/cbu-sync.env.example`

Provision a trusted always-on host in Uzbekistan with Node.js 20+ (do **not**
run the HMAC secret on a cashier/browser PC). Deploy only reviewed application
source into `/opt/qonoq-baggage/backend`; install the unit files into
`/etc/systemd/system/`, create a non-login user `qonoq-fx` and grant that
user read access to the checked-out files. The only required secrets are:

```ini
CBU_SYNC_TARGET_URL=https://YOUR-APPROVED-STAGING-BACKEND/api/integrations/cbu-rate-sync
CBU_SYNC_SHARED_SECRET=<64-character-random-hex-secret>
```

Generate the secret locally with `openssl rand -hex 32`; put the exact same
secret in the staging backend `CBU_SYNC_SHARED_SECRET` variable using a
secret manager. Configure `/etc/qonoq-cbu-sync.env` with permissions 600 and
ownership root; do not print the secret in terminal logs, tickets or chat.

To activate on the **trusted host after a real CBU smoke test**:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now qonoq-cbu-sync.timer
sudo systemctl start qonoq-cbu-sync.service
sudo systemctl status qonoq-cbu-sync.service --no-pager
sudo systemctl list-timers qonoq-cbu-sync.timer
```

The backend must run migration and have `CBU_RELAY_ENABLED=1` enabled only
when a signed update is observed and the daily quote endpoint returns trusted
rates. Verify a 100 RUB and 25 USD synthetic payment on staging and compare
cash-movement `fxRate`, `fxRateDate`, `fxSource`, `uzsEquivalent`
against Jarvis. Use the live official CBU rate from that day, **never** the
sample rates in automated tests. Roll back the feature if new payments cannot
get a trusted rate. Manual/estimated/browser fallback is prohibited.


## No-VPS option: CurrencyAPI CBU-source verification (diagnostics only)

If an Uzbekistan worker is unavailable, the already-connected Render host can reach
`https://api.currencyapi.com/v3/official?source=cbu` (an unauthenticated request
returns HTTP 401). CurrencyAPI is a **third party**, not the CBU website.
It supplies official-publication metadata via its `v3/official` endpoint;
unlike market/spot rates, this requests only `source=cbu`.

A read-only verification script is provided:
`node scripts/verifyCurrencyapiCbu.js`.

Set `CURRENCYAPI_KEY` as a secure environment variable, NEVER in source
code, query parameters, logs, tickets, chat or a frontend bundle. The script
requests five pairs using `source=cbu`, each with foreign `base_currency`
and `currencies=UZS`; verifies provider source, quoted direction, date
agreement, positive rate values, cross-rate disclosures and CBU publication
freshness, then prints diagnostic metadata. It **does not** write any rate to
PostgreSQL, enable production fallback or overwrite existing CBU data.

An alternative open mirror, `allratestoday.com/api/open/central-bank/cbu`,
was reachable from Render on 2026-10-28 but returned **2026-10-22** as
`rate_date` (`stale: true`). It must NOT be used to price new orders.

Before any production authorization: independently compare all five values
and effective dates against the original Central Bank on at least two
successive business days, inspect whether the provider returns a derived
rate (`cross_rates`), document compliance acceptance, then build an
explicit provenance-aware provider adapter and run end-to-end staging tests.
A diagnostic success is **not** sufficient to switch financial calculations.
