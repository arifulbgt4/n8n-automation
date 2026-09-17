# Deployment and operations

## 1. Environment model

Maintain separate development, staging, and production environments. Each environment must have isolated:

- PostgreSQL databases
- Redis
- n8n instance/database
- media namespace/bucket/root
- channel/webhook credentials where possible
- AI/provider keys
- application secrets

Never point development workflows at production callbacks or production customer data.

## 2. Initial VPS topology

The first production deployment may colocate services on the existing VPS, but preserve service boundaries:

```text
Reverse proxy / TLS
  |
  +-- customer-panel
  +-- super-admin-panel
  +-- backend-api
  +-- workers
  +-- n8n
  +-- media service
  |
  +-- PostgreSQL
  +-- Redis
```

Containers are recommended for repeatability. Stateful volumes require explicit backup policies.

## 3. Database layout

At minimum:

- `app_db`: SaaS business data.
- `n8n_db`: n8n internal data.

Use separate DB users/permissions. n8n internal DB user does not need access to `app_db` unless an explicitly reviewed read path exists; application/n8n integration should normally use service/API credentials.

Enable pgvector on `app_db`.

## 4. Redis

Use the VPS Redis initially. Requirements:

- authentication
- bind/private networking; no unrestricted public exposure
- memory policy chosen for queue/cache usage
- monitoring of memory, evictions, connections, latency
- persistence strategy appropriate for queue library, while still treating PostgreSQL as durable truth

## 5. Media service

Use `https://admin.openmusk.store/media` through a storage adapter. Before production launch verify:

- authenticated write/delete API
- namespace/tenant isolation
- HTTPS/TLS
- stable IDs/URLs
- backup strategy
- size/type limits
- health endpoint
- failure/error semantics

If any capability is missing, extend the media service or add an adapter/proxy service before relying on it for production customer data.

## 6. Reverse proxy and TLS

All external traffic uses HTTPS. Route customer app, admin app, API, n8n callback endpoints, and media according to least-exposure principles.

Do not expose PostgreSQL or Redis publicly.

Protect n8n editor/admin UI separately from public webhook paths.

## 7. Configuration/secrets

Use environment/secret management for infrastructure secrets. Never commit `.env` files containing real credentials.

Separate:

- application encryption key
- session/auth secrets
- DB credentials
- Redis credentials
- n8n encryption key
- platform Meta secrets
- platform AI provider secrets
- internal service tokens

Support rotation without rebuilding customer data.

## 8. Database migrations

Deployment pipeline order should support safe migrations:

1. backup/verify migration preconditions
2. run compatible expand migration
3. deploy API/workers/n8n changes
4. backfill/async migration where required
5. contract/remove obsolete fields only after all consumers are upgraded

Do not combine destructive schema changes with uncoordinated old workers.

## 9. Application deployment

Customer Panel and Super Admin Panel should be independently deployable even if they share packages. Backend/worker deploys must support graceful shutdown.

Health endpoints:

- liveness: process alive
- readiness: dependencies sufficiently available for traffic

## 10. Worker operations

Workers should:

- stop taking new jobs during shutdown
- finish or safely return active jobs to queue
- emit heartbeat/metrics
- support per-queue concurrency config
- avoid local filesystem as durable job state

## 11. n8n operations

Maintain version-controlled workflow exports or API-managed deployment artifacts. Production workflow changes should be promoted from staging and tracked by version.

Monitor:

- webhook health
- execution failures
- execution latency
- required workflow/version registration
- credential/config errors

## 12. Observability

Centralized or aggregated monitoring should cover:

### Metrics
- HTTP request rate/error/latency
- PostgreSQL connections/query latency/storage
- Redis memory/latency/evictions
- queue depth/age/throughput/failures
- worker heartbeats
- n8n failures
- media upload/download failures
- Meta API errors
- AI provider errors/latency/cost

### Logs
Structured, searchable, correlated across services.

### Traces/correlation
At minimum correlation IDs that connect webhook -> turn -> AI/n8n -> job -> outbound message -> business action.

## 13. Alerting

Critical alerts:

- API unavailable/error spike
- PostgreSQL/Redis unavailable
- queue oldest-job age above threshold
- dead-letter surge
- n8n webhook failures
- media service unavailable
- Meta/provider auth error spike
- AI provider outage/cost anomaly
- backup failure
- disk/volume near capacity

## 14. Backups

Production backup plan must cover:

- `app_db`
- `n8n_db`
- media storage
- critical deployment/configuration artifacts

Backups are only valid if restore tests are performed periodically.

## 15. Deployment rollback

Application rollback must account for database compatibility. Never roll code back to a version that cannot understand the current schema.

Prefer forward-fix for data migrations unless a verified backward-compatible rollback exists.

## 16. Scaling path

### Stage 1
Single VPS with containers and separate services.

### Stage 2
Multiple API/worker replicas; dedicated PostgreSQL/Redis resources; CDN/storage improvements.

### Stage 3
Managed/replicated data services, n8n queue mode or scaled automation architecture, independent worker pools, read replicas/partitioning where justified.

Scale based on measured bottlenecks, not premature component proliferation.

## 17. Data locality and time

Store timestamps in UTC. Businesses maintain timezone settings for display/scheduling. Follow-up/booking rules must explicitly convert between business/contact/provider time constraints.

## 18. Production readiness checklist

- TLS valid and auto-renewed.
- DB/Redis not public.
- backups and restore tested.
- secrets rotated from development defaults.
- super-admin MFA enabled.
- webhook verification enabled.
- rate limits configured.
- dead-letter/retry tooling available.
- media backups/limits verified.
- monitoring/alerts active.
- staging end-to-end Meta tests passed.
- tenant-isolation security tests passed.
- disaster/recovery runbook documented.

## 19. Operational ownership

Every major subsystem needs an owner/runbook:

- authentication/API
- database
- Redis/queues/workers
- media
- n8n
- Meta channels
- AI providers
- billing/usage

Normal support incidents should be diagnosable through logs/metrics/Super Admin without manual production database edits.