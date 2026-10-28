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
