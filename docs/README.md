# Documentation index

This directory is the implementation contract for the n8n Automation SaaS.

## Reading order

1. [`00_MASTER_PLAN.md`](00_MASTER_PLAN.md) — product vision, scope, principles, target capabilities, and end-to-end flows.
2. [`01_SYSTEM_ARCHITECTURE.md`](01_SYSTEM_ARCHITECTURE.md) — component boundaries, source-of-truth rules, runtime topology, and data flow.
3. [`02_DOMAIN_AND_DATABASE.md`](02_DOMAIN_AND_DATABASE.md) — domain model, PostgreSQL design, dynamic collections, relationships, and data ownership.
4. [`03_AUTH_TENANCY_RBAC.md`](03_AUTH_TENANCY_RBAC.md) — signup/signin, sessions, tenant membership, roles, authorization, and super-admin separation.
5. [`04_CUSTOMER_PANEL.md`](04_CUSTOMER_PANEL.md) — complete tenant-facing application specification.
6. [`05_SUPER_ADMIN_PANEL.md`](05_SUPER_ADMIN_PANEL.md) — complete platform-operator application specification.
7. [`06_CHANNELS_MESSAGING_MEDIA.md`](06_CHANNELS_MESSAGING_MEDIA.md) — Facebook/Instagram/WhatsApp accounts, conversations, screenshots, outbound delivery, media reuse, and rate limits.
8. [`07_AI_AGENTS_TRAINING_RAG.md`](07_AI_AGENTS_TRAINING_RAG.md) — AI providers, agent profiles, prompts, behavioral training, prompt versioning, and vector retrieval.
9. [`08_N8N_AUTOMATION.md`](08_N8N_AUTOMATION.md) — n8n responsibilities, workflow boundaries, event-driven orchestration, and migration from the legacy workflow.
10. [`09_REDIS_QUEUE_STORAGE.md`](09_REDIS_QUEUE_STORAGE.md) — Redis, jobs, workers, locks, cache, object/media storage, and async execution.
11. [`10_ANALYTICS_LIMITS_BILLING.md`](10_ANALYTICS_LIMITS_BILLING.md) — usage metering, channel metrics, quotas, plans, billing-ready design, and cost visibility.
12. [`11_SECURITY_RELIABILITY.md`](11_SECURITY_RELIABILITY.md) — secrets, tenant isolation, encryption, audit logs, abuse controls, backups, and recovery.
13. [`12_API_EVENTS_CONTRACTS.md`](12_API_EVENTS_CONTRACTS.md) — API conventions, service boundaries, domain events, idempotency, and webhook contracts.
14. [`13_DEPLOYMENT_OPERATIONS.md`](13_DEPLOYMENT_OPERATIONS.md) — environments, VPS services, deployment topology, observability, migrations, and operations.
15. [`14_IMPLEMENTATION_ROADMAP.md`](14_IMPLEMENTATION_ROADMAP.md) — phases, epics, task checklist, dependencies, and delivery order.
16. [`15_TESTING_ACCEPTANCE.md`](15_TESTING_ACCEPTANCE.md) — functional, integration, load, security, recovery, and acceptance requirements.
17. [`16_LEGACY_MIGRATION.md`](16_LEGACY_MIGRATION.md) — what to retain from `n8n_local_envirnment`, what to replace, and migration rules.

## Canonical decisions

The target platform has the following non-negotiable architecture decisions unless these documents are explicitly revised:

- PostgreSQL is the primary database and SaaS source of truth.
- `app_db` and the n8n internal database are separate. There is no manual or automatic database-to-database synchronization between them.
- The application/API reads and writes `app_db`; n8n and workers consume the same application state through approved APIs/data-access paths.
- Redis is used for cache, rate limiting, locks, short-lived state, aggregation, and queue coordination.
- Background workers are used for stateful/retryable asynchronous execution.
- `https://admin.openmusk.store/media` is the planned media/object-storage service endpoint; the implementation must wrap it behind a storage adapter and enforce authenticated tenant-scoped access.
- pgvector is the initial vector-search implementation.
- Google Sheets are removed from the target architecture.
- Multi-business, multi-channel, shared-catalog, and channel-specific override scenarios must all be supported.
- Dynamic products/services/custom datasets are built through controlled schema definitions and JSONB data, not arbitrary customer-created PostgreSQL tables.
- n8n is an orchestration engine, not the primary business-data store.

## Documentation change rule

If implementation reveals that a contract must change, update the relevant document in the same change set. Code and documentation must not intentionally diverge.