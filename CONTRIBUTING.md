# Contributing

Read docs/20_LOCAL_DEVELOPMENT.md first and run the stack locally before changing runtime code.

## 1. Engineering contract

The docs directory is the implementation contract.

Non-negotiable defaults:

- PostgreSQL app_db is the SaaS source of truth.
- n8n internal DB is separate and n8n-owned.
- Redis is transient cache/lock/rate-limit/queue/aggregation state.
- n8n orchestrates; it is not primary business storage.
- Media Storage is accessed server-side.
- tenant-defined data uses controlled metadata + JSONB, not arbitrary tenant-created SQL tables.
- tenant/business authorization is enforced server-side.
- secrets never belong in browser bundles, logs, tests, screenshots, workflow JSON, or Git.
- retryable asynchronous work must be idempotent.
- Google Sheets is not part of the target SaaS architecture.

If an implementation changes an architecture contract, update the relevant documentation in the same pull request.

## 2. Repository map

| Path | Responsibility |
| --- | --- |
| apps/api | Fastify API and route modules |
| apps/worker | BullMQ consumers and async processing |
| packages/core | shared env, DB, crypto, Redis/queue helpers, types |
| database/migrations | ordered PostgreSQL application migrations |
| customer-panel | tenant-facing Next.js application |
| super-admin-panel | operator-facing Next.js application |
| automation/n8n | sanitized version-controlled workflow bundle |
| scripts | migrations, admin bootstrap, n8n deploy, secret rotation |
| docs | architecture, contracts, testing, operations, roadmap |

## 3. Branch workflow

Start from current master:

~~~bash
git checkout master
git pull --ff-only origin master
git checkout -b feature/short-description
~~~

Recommended prefixes:

- feature/
- fix/
- security/
- docs/
- test/
- chore/
- refactor/

Keep a PR focused. Avoid unrelated schema, provider, UI, and refactor changes in one branch.

## 4. Commit messages

Use concise Conventional Commit-style history.

Examples:

~~~text
feat(channels): add reconnect diagnostics
fix(queue): encode BullMQ custom job IDs safely
security(admin): require recent MFA for destructive operations
test(api): cover tenant isolation
docs: document local development workflow
~~~

## 5. Read contracts before coding

Common references:

- docs/03_AUTH_TENANCY_RBAC.md
- docs/04_CUSTOMER_PANEL.md
- docs/05_SUPER_ADMIN_PANEL.md
- docs/06_CHANNELS_MESSAGING_MEDIA.md
- docs/07_AI_AGENTS_TRAINING_RAG.md
- docs/08_N8N_AUTOMATION.md
- docs/09_REDIS_QUEUE_STORAGE.md
- docs/10_ANALYTICS_LIMITS_BILLING.md
- docs/11_SECURITY_RELIABILITY.md
- docs/12_API_EVENTS_CONTRACTS.md
- docs/15_TESTING_ACCEPTANCE.md
- docs/18_IMPLEMENTATION_STATUS.md

Check implementation status before building a roadmap item so completed functionality is not duplicated.

## 6. Database rules

All durable schema changes require a new ordered SQL migration.

Rules:

1. Never silently mutate production schema from app startup.
2. Do not rewrite an already-applied migration. Add a new one.
3. Use the next sequential migration filename.
4. Prefer an explicit transaction when safe.
5. Add foreign keys and indexes for actual access patterns.
6. Tenant-owned records must have unambiguous tenant ownership.
7. Preserve historical snapshots where transaction history requires them.
8. Never create arbitrary per-tenant physical tables/columns.
9. Never place n8n internal tables in app_db.
10. Test clean-database migration and upgrade behavior for non-trivial changes.

Commands:

~~~bash
npm run db:status
npm run db:migrate
~~~

## 7. API rules

For every new/changed route:

- validate external input explicitly
- authenticate before tenant-owned access
- enforce active tenant membership and business scope
- enforce platform-admin authority separately from tenant roles
- require CSRF for browser-authenticated mutation routes
- use idempotency for retryable mutations
- return stable errors without leaking internals
- keep request/correlation IDs
- audit sensitive/security/admin/business-state operations
- never return raw secrets
- keep infrastructure URLs out of domain logic
- test authorization and failure behavior

Register route modules in apps/api/src/server.ts.

## 8. Tenant isolation

Never trust tenantId or businessId merely because the client sent it.

Each access path must prove principal authority and resource ownership. Cross-tenant access must be denied without exposing another tenant's data.

Tenant isolation is release-critical, not a UI concern.

## 9. Queue and worker rules

Use shared helpers from @n8n-automation/core.

Requirements:

- durable state goes to PostgreSQL
- Redis/BullMQ is never the sole durable record
- jobs have stable application idempotency keys
- use shared BullMQ-safe custom-ID handling
- classify retryable vs permanent failures
- use bounded retry/backoff/jitter
- respect provider/global/plan/tenant/contact limits
- locks use TTL and ownership tokens
- workers shut down gracefully
- terminal failures are observable
- PostgreSQL/outbox can recover work after Redis loss

New queue families must update shared definitions, worker registration, observability/admin surfaces, and docs.

## 10. Secret handling

Never commit:

- .env or .env.local
- Meta app secrets/tokens
- AI provider keys
- Media Storage bearer/admin tokens
- n8n API keys
- production DB/Redis credentials
- encryption keys
- session/internal-service secrets

APP_ENCRYPTION_KEY is 32 bytes encoded as 64 hex characters.

Review the existing rotation mechanism before changing encrypted formats:

~~~bash
npm run secrets:rotate
~~~

Do not remove previous-key support until records are re-encrypted and verified.

## 11. Customer Panel rules

- use the shared API client
- preserve credentials/include-cookie behavior
- preserve CSRF behavior
- show safe actionable errors
- enforce authorization in the API even if UI hides a control
- test tenant/business switching
- handle loading, empty, error, and permission states

## 12. Super Admin rules

- never rely on UI-only authorization
- preserve MFA/re-auth gates for dangerous actions
- make destructive actions explicit
- show tenant context clearly
- keep operator actions auditable
- do not expose secrets in diagnostics

## 13. n8n workflow rules

Workflow JSON is deployment source material.

When changing automation/n8n:

- keep JSON sanitized
- never include secrets/customer data
- avoid production-only credential IDs
- use configuration/internal credential aliases
- keep workflows modular
- preserve API idempotency
- update manifest metadata/version when appropriate
- validate before commit

~~~bash
npm run validate:n8n
npm run n8n:plan
~~~

Production activation requires the controlled deployment process; JSON validation alone is not approval to activate.

## 14. Media rules

- conversation/training files are private by default
- credentials remain server-side
- media mappings preserve tenant ownership
- dedupe only within authorized scope
- referenced media is not blindly deleted
- application quota and Media Storage quota behavior stay aligned
- provider remote-media IDs may expire and must be refreshable

## 15. AI/provider rules

Preserve:

- BYOK/platform-paid separation
- encrypted credentials
- task-specific routing
- fallback policy
- token/usage/cost accounting
- tenant budget/limit enforcement
- SSRF controls on configurable provider URLs
- structured validation for tools/actions
- live DB facts over model assumptions

## 16. Dynamic data rules

Customer-defined data uses schema metadata + JSONB.

- validate field types
- allowlist search/filter/sort fields
- preserve schema version/concurrency checks
- validate relation ownership
- add indexes for actual queries
- never execute customer SQL
- never create per-customer physical DB tables

## 17. Testing

Add the narrowest automated test that proves the behavior.

High-risk areas require integration coverage when applicable:

- tenant isolation
- RBAC/authorization
- CSRF
- webhook signatures
- idempotency
- queue retries
- provider failures
- secret masking
- admin MFA/re-auth
- migrations

Before PR:

~~~bash
set -a
source .env.local
set +a

npm run db:migrate
npm run validate:n8n
npm run typecheck
npm run test
npm run build
npm run lint
~~~

A PR should not merge with a known failing CI check.

## 18. Documentation requirements

Update docs in the same PR when changing:

- env variables
- ports/startup commands
- domain/database contracts
- API/event contracts
- RBAC
- queue behavior
- provider behavior
- n8n workflows/deployment
- production operations
- roadmap completion status

Code and docs must not intentionally diverge.

## 19. Pull request checklist

- [ ] based on current master
- [ ] focused scope
- [ ] no secrets/customer credentials in diff
- [ ] new migration for durable schema changes
- [ ] tenant/business authorization enforced
- [ ] mutation/idempotency behavior reviewed
- [ ] relevant tests updated
- [ ] n8n validation passes when workflows changed
- [ ] typecheck passes
- [ ] tests pass
- [ ] build passes
- [ ] docs/env examples updated
- [ ] UI manually checked where applicable
- [ ] migration/config/security/rollback risks described

PR description should explain what changed, why, affected services, migrations/configuration, security impact, verification performed, screenshots for meaningful UI changes, and rollback considerations.

## 20. Review priorities

Review in this order:

1. tenant isolation and authorization
2. secrets/security boundaries
3. data durability and idempotency
4. migration correctness
5. provider failure/retry behavior
6. API compatibility
7. observability/recovery
8. tests
9. UI behavior
10. documentation consistency

## 21. Definition of done

A repository-owned task is done only when implementation, migrations/config, authorization/security, tests, typecheck/build, workflow validation where applicable, required UI, and documentation are complete and CI is green.

Production/environment tasks are not completed by source code alone. Live n8n import, Meta approval, production secrets, backup verification, load tests, restore drills, and pilot launch require evidence from the target environment.
