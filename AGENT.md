# Repository implementation rules

This repository is currently documentation-first.

## Mandatory planning rules

1. Read `docs/README.md` and `docs/00_MASTER_PLAN.md` before implementation work.
2. Treat PostgreSQL `app_db` as the SaaS source of truth. Never mirror SaaS business data into the n8n internal database.
3. Keep the n8n internal database and SaaS application database logically isolated.
4. Do not reintroduce Google Sheets as configuration, catalog, order, prompt, provider, or operational storage. Sheets belong only to the legacy prototype.
5. n8n is an automation/orchestration runtime. Business rules and durable source-of-truth state must remain in the application/API/database layer.
6. All tenant-owned records must be tenant-scoped and authorization-checked. Cross-tenant access is forbidden except through explicitly authorized super-admin operations.
7. Customer-defined fields must use the dynamic collection/schema system. Do not create arbitrary physical PostgreSQL columns or tables per customer.
8. Secrets such as Meta tokens and AI-provider API keys must be encrypted at rest and never returned in full after storage.
9. Media binaries belong in the media/object-storage service, not in PostgreSQL.
10. Rate limits, retries, idempotency, queueing, and delivery state are first-class requirements for messaging.
11. Prompt training produces versioned prompt/agent candidates. Training must not silently overwrite the active production prompt unless the customer explicitly enables an approved auto-publish policy.
12. Every significant implementation change must update the corresponding documentation and acceptance criteria.

## Target applications

- `customer-panel`: tenant/customer-facing SaaS application.
- `super-admin-panel`: platform operator/control application.
- Future backend/API, worker, and shared packages must follow the contracts in `docs/`.

## Change discipline

During the planning phase, do not modify runtime/source-code files unless the user explicitly authorizes implementation. Documentation changes are allowed and expected.