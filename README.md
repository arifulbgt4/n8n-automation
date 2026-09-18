# n8n Automation SaaS

This repository is the target SaaS application for a multi-tenant, configurable AI business automation platform. The platform will let customers connect Facebook, Instagram, WhatsApp, and future channels; define their own products, services, or custom business data; configure AI providers and agents; train agent behavior from example conversations; manage conversations, orders, bookings, leads, media, and usage; and run automations through n8n.

## Current status

The repository is in the **full-platform implementation / production-readiness phase**. Repository-owned runtime code is implemented across the Fastify API, BullMQ worker, PostgreSQL/pgvector migrations, Redis coordination, Customer Panel, Super Admin Panel, AI/training/RAG, messaging/media, business actions, billing-ready models, n8n workflow bundle, deployment tooling, security controls, observability, retention, and operational recovery. Remaining open roadmap items are environment-owned production activation or explicitly conditional features; see `docs/18_IMPLEMENTATION_STATUS.md`.

## Existing infrastructure assumption

Core infrastructure services are already provisioned outside this application repository. This repository must **integrate with them, not reinstall or re-provision them**.

The existing services include:

- PostgreSQL runtime/host infrastructure; this project owns the SaaS `app_db` schema and migrations.
- Redis for cache, rate limiting, locks, aggregation, and queue coordination.
- n8n runtime for importing and executing this project's version-controlled workflow JSON artifacts.
- A multi-user Media Storage service for file/object storage.

Infrastructure-specific repository locations, admin-panel URLs, hostnames, ports, and credentials are deployment configuration and must not be hard-coded into this repository's architecture documentation or application code.

## Core architecture decisions

- **PostgreSQL** is the SaaS source of truth.
- The SaaS application database and the n8n internal database are separate databases. They are **not synchronized copies**.
- **n8n** is the automation/orchestration runtime, not the source of truth.
- **Redis** is used for caching, rate limiting, distributed locks, short-lived state, aggregation windows, and queue coordination.
- Background workers/queues handle outbound messaging, AI jobs, media processing, embeddings, follow-ups, training jobs, analytics aggregation, retries, and other asynchronous work.
- The existing multi-user Media Storage service is the media/object-storage layer and is consumed through a server-side storage adapter.
- **pgvector** on PostgreSQL is the initial vector-search layer.
- Google Sheets are **not part of the target SaaS architecture**.
- `customer-panel` is the tenant-facing application.
- `super-admin-panel` is the platform-operator application.

## n8n workflow delivery

This repository keeps sanitized, version-controlled n8n workflow JSON exports as deployment artifacts, with manifest validation and deployment tooling. The existing n8n instance is not installed or managed here. Production activation still requires the exact deployed n8n version, environment-specific credentials/settings, inactive import verification, and controlled cutover.

## Documentation

Start with [`docs/README.md`](docs/README.md) and [`docs/00_MASTER_PLAN.md`](docs/00_MASTER_PLAN.md).

The documentation covers system architecture, database/domain design, authentication and multi-tenancy, both web applications, dynamic business data, messaging/media, AI agents and training, n8n workflow artifacts, Redis/queues/storage, analytics and limits, security, API/event contracts, deployment, testing, migration, and the complete implementation roadmap.

## Implementation rule

Runtime implementation is authorized. Treat the specs in `docs/` as the contract, keep code/tests/workflow artifacts/documentation aligned, and only mark a roadmap item complete when repository evidence exists or the external production verification has actually occurred.