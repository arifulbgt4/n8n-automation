# Operational runbook

This runbook covers application-owned recovery and diagnosis. PostgreSQL host operations, Redis host operations, n8n host operations, Media Storage host operations, reverse proxy/TLS and physical backup systems remain owned by infrastructure operations.

## 1. First response

For every incident:

1. Capture the request/correlation ID, tenant, business, channel and approximate time.
2. Check Super Admin **Infrastructure Health**, **Automation / n8n**, **Queues / Jobs**, **Audit**, and channel diagnostics.
3. Do not edit production database rows manually unless an approved recovery procedure explicitly requires it.
4. Preserve failed jobs and audit evidence until the cause is understood.

## 2. API unavailable or elevated 5xx

Check:

- `/healthz` for process liveness.
- `/readyz` for required PostgreSQL/Redis readiness.
- Super Admin health latency for PostgreSQL/Redis/Media/n8n.
- API request metrics for 5xx rate and latency.
- deployment logs by correlation ID.

If PostgreSQL is unavailable, stop mutating traffic rather than accepting non-durable business writes. If Redis is unavailable, durable PostgreSQL records remain authoritative; recover Redis, then allow outbox/queue dispatch to repopulate asynchronous work.

## 3. Redis loss or restart

Redis never owns the only copy of business state.

Recovery:

1. restore Redis connectivity.
2. verify workers reconnect and heartbeat.
3. inspect outbox events in pending/failed state.
4. verify scheduled follow-ups still exist in PostgreSQL.
5. let the outbox dispatcher republish eligible work.
6. inspect failed/dead-letter jobs before manual retry.

Do not reconstruct business records from Redis.

## 4. Queue backlog / dead-letter surge

1. inspect queue depth, oldest waiting age and worker heartbeat.
2. identify whether failures are retryable provider/network failures or permanent 4xx/auth/configuration failures.
3. fix credentials/configuration/provider issue first.
4. retry individual failed jobs from Super Admin.
5. remove a job only when it is known to be obsolete; destructive removal requires recent admin MFA.
6. verify transport/business idempotency before bulk replay.

Human replies and active customer responses retain higher delivery priority than follow-ups/background work.

## 5. Meta channel authentication failure

Symptoms include degraded channel state, 401/403 delivery failure or webhook silence.

1. open channel diagnostics.
2. verify account ID, Graph API version and credential metadata.
3. rotate/reconnect the credential through the Customer Panel.
4. run the connection test.
5. verify Meta webhook subscription and production permissions externally.
6. replay only safe/idempotent failed outbound jobs.

Never paste Meta tokens into logs, n8n JSON or Git.

## 6. Provider webhook reconciliation

If Meta reports an event that is missing in the application:

1. search by provider message/event ID and channel account.
2. confirm the receiving external account maps to exactly one active channel.
3. verify webhook HMAC/signature configuration and endpoint access.
4. if the provider retries, inbound idempotency will suppress duplicates.
5. if a historical provider event must be replayed, use the internal normalized-event path only through an authorized service and preserve the original provider IDs.
6. compare delivery/read provider status with stored outbound `platform_message_id`.

Never create duplicate orders/bookings/leads to compensate for an uncertain webhook; use idempotency keys and inspect the existing action first.

## 7. n8n bundle mismatch or failure

Git `automation/n8n/manifest.json` + workflow JSON is the deployment source of truth.

1. compare expected bundle version with runtime heartbeat/deployment metadata.
2. validate the bundle locally/CI.
3. import/update the new bundle while inactive.
4. bind environment credentials.
5. verify webhook/schedule conflicts.
6. run test events.
7. activate required workflows as a controlled cutover.
8. retain the previous compatible bundle during the rollback window.

Rollback uses the previous compatible Git bundle; do not treat the n8n internal database as the only workflow backup.

## 8. Media Storage incident

1. check Media Storage health and tenant media-account status.
2. distinguish quota, authentication, not-found and service-availability failures.
3. rotate/reprovision the tenant Media Storage credential when revoked.
4. do not expose bearer credentials to browsers.
5. private files remain private unless explicitly published for provider fetching.
6. remote provider media IDs are a cache; stale IDs may be refreshed/re-uploaded from the canonical Media Storage asset.
7. reference-aware application deletion must not claim provider-side copies were deleted.

Recovery requires both Media Storage metadata/database and physical bytes.

## 9. AI provider outage or cost anomaly

1. check model/provider connection status and recent delivery/AI errors.
2. inspect current 24h estimated AI cost vs previous daily average in Super Admin.
3. verify whether fallback model routing is permitted/configured.
4. for BYOK tenants, require the tenant to rotate/fix its provider key when appropriate.
5. for platform-paid AI, reduce/disable affected model routes or feature flags if budget risk is material.
6. never log decrypted provider keys or full provider credentials.

## 10. Human handoff safety

When a conversation is in HUMAN mode:

- AI responses and automated follow-ups must not send.
- Page-owner/API echoes must not be mistaken for new customer input.
- resume AI only through the explicit conversation control.
- inspect conversation state version if a generated response was suppressed.

## 11. Retention / export / deletion

Exports and deletion are durable jobs. Export results are private Media Storage assets. Tenant deletion requires owner password confirmation and first suspends automation. Retention cleanup only removes data according to the tenant policy and writes an audit event when records are removed.

## 12. Backup recovery objectives

Application design targets, subject to infrastructure-owner confirmation:

- `app_db`: target RPO <= 15 minutes when PITR/continuous backup is available; target RTO <= 2 hours.
- Media Storage metadata + physical bytes: target RPO <= 24 hours; target RTO <= 4 hours.
- n8n project workflow definitions: Git is authoritative for project workflows; target RTO <= 1 hour after runtime availability.
- Redis: no durable-business-data RPO requirement; application recovery uses PostgreSQL/outbox and repopulates transient state.

If infrastructure cannot meet these objectives, record the accepted values before production launch.

## 13. Restore exercise

A production-readiness restore exercise must:

1. restore `app_db` into an isolated environment.
2. verify migrations/schema and encrypted-secret decryption using the approved key process.
3. restore/reconcile Media Storage metadata plus bytes and verify `media_assets` references.
4. start isolated Redis and workers and confirm outbox/queue recovery.
5. import the Git workflow bundle into an isolated n8n runtime and verify expected bundle metadata.
6. execute a synthetic tenant flow without contacting production customers.
7. record measured recovery time and any data gap.

## 14. Release / rollback

Deploy database-compatible changes first, then API/workers/panels, then n8n bundle cutover. Prefer forward-fix after destructive migrations. Do not roll application or workflows back to a contract version that cannot understand the deployed database schema.

## 15. Escalation evidence

Keep:

- correlation/request ID.
- tenant/business/channel IDs (never secret values).
- provider message/event IDs.
- queue/job ID.
- n8n workflow/bundle version.
- deployment commit SHA.
- error status/classification.
- timestamps in UTC.

This evidence should be sufficient for diagnosis without exposing credentials or editing source-of-truth records manually.
