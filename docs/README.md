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
9. [`08_N8N_AUTOMATION.md`](08_N8N_AUTOMATION.md) — n8n responsibilities, modular workflows, JSON artifact lifecycle, import/update/activation rules, and runtime integration.
10. [`09_REDIS_QUEUE_STORAGE.md`](09_REDIS_QUEUE_STORAGE.md) — Redis, jobs, workers, locks, cache, Media Storage integration, and async execution.
11. [`10_ANALYTICS_LIMITS_BILLING.md`](10_ANALYTICS_LIMITS_BILLING.md) — usage metering, channel metrics, quotas, plans, billing-ready design, and cost visibility.
12. [`11_SECURITY_RELIABILITY.md`](11_SECURITY_RELIABILITY.md) — secrets, tenant isolation, encryption, audit logs, abuse controls, backups, and recovery.
13. [`12_API_EVENTS_CONTRACTS.md`](12_API_EVENTS_CONTRACTS.md) — API conventions, service boundaries, domain events, idempotency, and webhook contracts.
14. [`13_DEPLOYMENT_OPERATIONS.md`](13_DEPLOYMENT_OPERATIONS.md) — application deployment into the existing infrastructure, observability, migrations, and operations.
15. [`14_IMPLEMENTATION_ROADMAP.md`](14_IMPLEMENTATION_ROADMAP.md) — phases, epics, task checklist, dependencies, and delivery order.
16. [`15_TESTING_ACCEPTANCE.md`](15_TESTING_ACCEPTANCE.md) — functional, integration, load, security, recovery, and acceptance requirements.
17. [`16_LEGACY_MIGRATION.md`](16_LEGACY_MIGRATION.md) — behavioral migration from the earlier spreadsheet-driven prototype.
18. [`17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md`](17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md) — explicit rules for consuming the already-running PostgreSQL/Redis/n8n/Media services and deploying n8n JSON workflow bundles.
19. [`18_IMPLEMENTATION_STATUS.md`](18_IMPLEMENTATION_STATUS.md) — implemented repository state, automated verification, and production/environment activation gates.
20. [`19_OPERATIONAL_RUNBOOK.md`](19_OPERATIONAL_RUNBOOK.md) — incident diagnosis, queue/provider recovery, n8n rollback, Redis-loss recovery, backup objectives, and restore exercise.
21. [`20_LOCAL_DEVELOPMENT.md`](20_LOCAL_DEVELOPMENT.md) — complete local environment setup, startup workflow, migrations, integrations, CI parity, reset procedures, and troubleshooting.

Contributor workflow and engineering standards are documented in [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Canonical decisions

The target platform has the following non-negotiable architecture decisions unless these documents are explicitly revised:

- PostgreSQL is the primary database and SaaS source of truth.
- `app_db` and the n8n internal database are separate. There is no manual or automatic database-to-database synchronization between them.
- The application/API reads and writes `app_db`; n8n and workers consume the same application state through approved APIs/data-access paths.
- PostgreSQL, Redis, n8n, and Media Storage infrastructure are already provisioned outside this application repository. This repository integrates with those services and does not own their installation.
- Redis is used for cache, rate limiting, locks, short-lived state, aggregation, and queue coordination.
- Background workers are used for stateful/retryable asynchronous execution.
- The existing multi-user Media Storage service is consumed through a server-side storage adapter using its authenticated user API; infrastructure-specific URLs and admin endpoints are deployment configuration, not architecture constants.
- n8n workflow JSON exports are version-controlled deployment artifacts. The existing n8n runtime imports/updates those artifacts; n8n itself is not installed by this repository.
- pgvector is the initial vector-search implementation.
- Google Sheets are removed from the target architecture.
- Multi-business, multi-channel, shared-catalog, and channel-specific override scenarios must all be supported.
- Dynamic products/services/custom datasets are built through controlled schema definitions and JSONB data, not arbitrary customer-created PostgreSQL tables.
- n8n is an orchestration engine, not the primary business-data store.

## Documentation change rule

If implementation reveals that a contract must change, update the relevant document in the same change set. Code and documentation must not intentionally diverge.