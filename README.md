# n8n Automation SaaS

This repository is the target SaaS application for a multi-tenant, configurable AI business automation platform. The platform will let customers connect Facebook, Instagram, WhatsApp, and future channels; define their own products, services, or custom business data; configure AI providers and agents; train agent behavior from example conversations; manage conversations, orders, bookings, leads, media, and usage; and run automations through n8n.

## Current status

The repository is intentionally in a **documentation-first planning phase**. The existing `customer-panel` and `super-admin-panel` are application shells. No implementation work should begin until the architecture, data model, security boundaries, integration contracts, and implementation phases in `docs/` are reviewed.

## Core architecture decisions

- **PostgreSQL** is the SaaS source of truth.
- The SaaS application database and the n8n internal database are separate databases. They are **not synchronized copies**.
- **n8n** is the automation/orchestration runtime, not the source of truth.
- **Redis** is used for caching, rate limiting, distributed locks, short-lived state, aggregation windows, and queue coordination.
- Background workers/queues handle outbound messaging, AI jobs, media processing, embeddings, follow-ups, training jobs, analytics aggregation, retries, and other asynchronous work.
- Existing VPS media storage exposed through `https://admin.openmusk.store/media` is the planned media/object-storage layer, subject to the storage API/security contract defined in the documentation.
- **pgvector** on PostgreSQL is the initial vector-search layer.
- Google Sheets are part of the legacy prototype only and are **not part of the target SaaS architecture**.
- `customer-panel` is the tenant-facing application.
- `super-admin-panel` is the platform-operator application.

## Documentation

Start with [`docs/README.md`](docs/README.md) and [`docs/00_MASTER_PLAN.md`](docs/00_MASTER_PLAN.md).

The documentation covers system architecture, database/domain design, authentication and multi-tenancy, both web applications, dynamic business data, messaging/media, AI agents and training, n8n integration, Redis/queues/storage, analytics and limits, security, API/event contracts, deployment, testing, migration, and the complete implementation roadmap.

## Legacy reference

The earlier prototype lives in `arifulbgt4/n8n_local_envirnment`. It is useful as a behavioral reference for Meta routing, human handoff, follow-ups, media reuse, AI-provider routing, and n8n workflow behavior. Its spreadsheet-driven configuration is explicitly replaced by the SaaS database and web panels in this repository.

## Documentation-first rule

Until the planning phase is closed, changes should be limited to documentation unless an implementation task is explicitly approved. Future implementation must treat the specs in `docs/` as the contract and update the specs whenever a design decision changes.