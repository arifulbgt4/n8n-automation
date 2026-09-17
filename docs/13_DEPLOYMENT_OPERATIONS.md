# Deployment and operations

## 1. Environment model

Maintain separate development, staging, and production application environments. Each environment uses isolated application data/credentials/workflow deployment state.

The underlying PostgreSQL, Redis, n8n, Media Storage, reverse-proxy/TLS, and host service-management infrastructure is already provisioned separately. This repository consumes those services and does not reinstall them.

Never point development workflows at production callbacks or production customer data.

## 2. Application deployment boundary

This repository deploys:

```text
customer-panel
super-admin-panel
backend-api
workers
app_db migrations
n8n workflow JSON bundle
```

It configures clients/connections to:

```text
existing PostgreSQL
existing Redis
existing n8n runtime
existing Media Storage service
```

Infrastructure-specific repository paths, public/admin URLs, ports, and credentials are deployment configuration and must not be hard-coded into application architecture/source.

## 3. Database layout

At minimum:

- `app_db`: SaaS business data owned/migrated by this application.
- n8n internal database: n8n-owned state, logically separate.

Use separate database users/permissions. Application/n8n integration normally uses service/API credentials rather than giving n8n broad write access to `app_db`.

Enable pgvector in `app_db` when vector features are introduced.

Deployment work is migrations/permissions/connectivity—not PostgreSQL installation.

## 4. Redis integration

Use the existing Redis service.

Application responsibilities:

- configured authenticated client connection.
- application/environment key prefix.
- queue/job namespace.
- rate limiter/lock/cache implementation.
- monitoring of application-owned queue depth/age, errors, latency, and cache behavior.

Do not add Redis server provisioning to this repository.

## 5. Media Storage integration

Use the existing multi-user Media Storage service through the server-side storage adapter defined in the media specifications.

Application responsibilities:

- tenant-to-media-user mapping.
- secure bearer credential storage/reference.
- upload/list/metadata/content/visibility/delete adapter.
- private/public policy.
- `media_assets` metadata/relationships.
- quota/error handling.
- provider remote-media reuse.
- application-level health monitoring.

The Media Storage service already owns physical bytes, storage-level metadata/quota enforcement, and its own lifecycle. Do not duplicate the service in this repository.

## 6. Reverse proxy and TLS

Host-level reverse proxy/TLS is infrastructure-owned. Application deployments provide the required service routes/ports and health endpoints to the infrastructure configuration.

Do not expose PostgreSQL or Redis publicly.

Public provider webhooks and customer/admin/API routes use HTTPS. n8n editor/admin access remains protected separately from public webhook paths.

## 7. Configuration/secrets

Use environment/secret management. Never commit real `.env` credentials.

Separate:

- application encryption key.
- session/auth secrets.
- app DB credential.
- Redis credential.
- tenant Media Storage credentials/references.
- internal service authentication.
- Meta secrets.
- AI provider secrets.
- platform-level n8n credentials when required.

Support rotation without rebuilding customer data.

## 8. Database migrations

Safe deployment order:

1. backup/verify migration preconditions.
2. run compatible expand migration.
3. deploy API/workers/workflow bundle changes compatible with both states where required.
4. run backfill/async migration.
5. contract/remove obsolete fields only after all consumers are upgraded.

Do not combine destructive schema changes with uncoordinated old workers/workflows.

## 9. Application deployment

Customer Panel and Super Admin Panel should be independently deployable even if they share packages. Backend/worker deploys support graceful shutdown.

Health endpoints:

- liveness: process alive.
- readiness: required dependencies sufficiently available.

Readiness should distinguish required dependencies from degradable ones so operators can diagnose whether failure is DB, Redis/queue, Media Storage, AI provider, or channel provider related.

## 10. Worker operations

Workers should:

- stop accepting new jobs during shutdown.
- finish or safely return active jobs to queue.
- emit heartbeat/metrics.
- support per-queue concurrency configuration.
- avoid local filesystem as durable job state.
- use Media Storage for durable binary files.

## 11. n8n workflow deployment

The n8n runtime already exists. Application deployment only manages this project's workflow JSON bundle.

Required process:

1. maintain sanitized workflow JSON exports in Git.
2. maintain workflow bundle manifest/version.
3. import/update workflows in the existing n8n runtime.
4. keep newly imported bundle inactive while configuring/testing.
5. bind environment-specific platform/internal credentials.
6. verify webhook/schedule conflicts.
7. run health/end-to-end tests.
8. perform controlled trigger cutover.
9. record deployed n8n workflow IDs + bundle version.
10. retain previous compatible bundle for bounded rollback.

Major changes should prefer blue/green workflow bundle deployment.

Never commit n8n credentials/database exports/customer secrets in workflow JSON.

See `08_N8N_AUTOMATION.md` and `17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md`.

## 12. Observability

### Metrics

- HTTP request rate/error/latency.
- app DB connections/query latency/storage.
- Redis client latency/errors and queue depth/age.
- worker heartbeats.
- n8n workflow failures/latency/bundle health.
- Media Storage upload/download/quota failures.
- Meta API errors.
- AI provider errors/latency/cost.

### Logs

Structured, searchable, correlated across services. Never log decrypted secrets.

### Correlation

At minimum connect:

```text
webhook -> conversation turn -> AI/n8n -> job -> outbound message -> business action
```

## 13. Alerting

Critical alerts:

- API unavailable/error spike.
- app DB dependency unavailable.
- Redis/queue unavailable or oldest-job age too high.
- dead-letter surge.
- n8n workflow/webhook failure or version mismatch.
- Media Storage unavailable/quota/capacity error spike.
- Meta/provider auth error spike.
- AI provider outage/cost anomaly.
- backup failure.
- infrastructure capacity warning surfaced by existing monitoring.

## 14. Backups

Application recovery depends on:

- `app_db` backup.
- n8n internal state/workflow infrastructure backup performed by infrastructure operations.
- version-controlled n8n workflow JSON bundle in Git.
- Media Storage metadata/database + physical file backup performed by infrastructure operations.
- critical deployment configuration/secrets backup according to security policy.

Backups are valid only when restore procedures are periodically tested.

## 15. Deployment rollback

Application rollback must account for database/API/workflow compatibility. Never roll code/workflow back to a version that cannot understand the current schema/contract.

Prefer forward-fix for destructive data migrations unless a verified backward-compatible rollback exists.

## 16. Scaling path

The application scales by measured bottleneck:

- multiple API replicas.
- independent worker pools by queue.
- optimized DB indexes/query paths and later read replicas/partitioning if justified.
- Redis/queue capacity changes through infrastructure operations.
- n8n scaling through the existing infrastructure operating model.
- Media Storage capacity/CDN evolution through its infrastructure owner.

Do not duplicate infrastructure services inside this repository as a scaling shortcut.

## 17. Data locality and time

Store timestamps in UTC. Businesses maintain timezone settings for display/scheduling. Follow-up/booking rules explicitly convert between business/contact/provider time constraints.

## 18. Production readiness checklist

- [ ] app DB migrations verified.
- [ ] app DB/Redis not exposed to browser/public internet.
- [ ] secrets rotated from development defaults.
- [ ] super-admin MFA enabled.
- [ ] webhook verification/signatures enabled.
- [ ] rate limits configured.
- [ ] dead-letter/retry tooling available.
- [ ] tenant Media Storage user mapping/credentials tested.
- [ ] Media Storage private/public behavior tested.
- [ ] n8n workflow bundle imported/configured/tested while inactive.
- [ ] duplicate webhook/schedule bundle conflict eliminated.
- [ ] expected/deployed workflow bundle versions match.
- [ ] monitoring/alerts active.
- [ ] staging end-to-end Meta tests passed.
- [ ] tenant-isolation security tests passed.
- [ ] backup/restore responsibilities verified with infrastructure operations.
- [ ] disaster/recovery runbook documented.

## 19. Operational ownership

Every subsystem needs an owner/runbook:

- authentication/API.
- application database/schema.
- Redis queues/application workers.
- Media Storage application integration.
- n8n workflow bundle/runtime integration.
- Meta channels.
- AI providers.
- billing/usage.

Normal support incidents should be diagnosable through logs/metrics/Super Admin without manual production database edits.