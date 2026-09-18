# Repository implementation rules

This repository is currently documentation-first.

## Mandatory planning rules

1. Read `docs/README.md`, `docs/00_MASTER_PLAN.md`, and `docs/17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md` before implementation work.
2. Treat PostgreSQL `app_db` as the SaaS source of truth. Never mirror SaaS business data into the n8n internal database.
3. Keep the n8n internal database and SaaS application database logically isolated.
4. Do not introduce Google Sheets as configuration, catalog, order, prompt, provider, or operational storage.
5. n8n is an automation/orchestration runtime. Business rules and durable source-of-truth state remain in the application/API/database layer.
6. PostgreSQL host/runtime, Redis, n8n, Media Storage, reverse proxy/TLS, and host service management are pre-provisioned outside this repository. Do not add duplicate infrastructure installation/provisioning unless the user explicitly changes that architecture decision.
7. Infrastructure repository paths, admin URLs, hostnames, ports, and real credentials are deployment configuration. Do not hard-code them into domain/application logic or canonical architecture documentation.
8. This repository owns version-controlled, sanitized n8n workflow JSON bundles and their manifest. Never commit n8n credential exports, n8n database contents, customer secrets, or production-only credential IDs as workflow source-of-truth.
9. All tenant-owned records must be tenant-scoped and authorization-checked. Cross-tenant access is forbidden except through explicitly authorized super-admin operations.
10. Customer-defined fields use the dynamic collection/schema system. Do not create arbitrary physical PostgreSQL columns/tables per customer.
11. Secrets such as Meta tokens, AI-provider API keys, and Media Storage bearer keys must be encrypted/referenced server-side and never returned in full after storage.
12. Media binaries belong in the existing Media Storage service, not PostgreSQL. Prefer one Media Storage user/account per SaaS tenant; customer browsers never receive Media Storage bearer credentials.
13. Rate limits, retries, idempotency, queueing, and delivery state are first-class messaging requirements.
14. Prompt training produces versioned prompt/agent candidates. Training must not silently overwrite the active production prompt unless the customer explicitly enables an approved auto-publish policy.
15. Every significant implementation change must update the corresponding documentation and acceptance criteria.

## Target applications

- `customer-panel`: tenant/customer-facing SaaS application.
- `super-admin-panel`: platform operator/control application.
- future backend/API, worker, shared packages, and n8n workflow artifact directories must follow the contracts in `docs/`.

## n8n workflow artifact rule

When implementation starts, store project n8n JSON exports under a dedicated version-controlled automation directory with a manifest. Imported production workflows are deployment targets; Git JSON + manifest are the application-owned deployment source.

New workflow bundles are imported/configured/tested while inactive and activated through controlled cutover. Avoid duplicate active webhook/schedule bundles.

## Change discipline

During the planning phase, do not modify runtime/source-code files unless the user explicitly authorizes implementation. Documentation changes are allowed and expected.