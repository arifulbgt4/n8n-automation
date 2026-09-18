# Implementation roadmap and complete task plan

This file is the delivery checklist and current implementation status. Repository-owned runtime implementation is active and code-complete items are checked below. Unchecked items are production/environment verification gates or explicitly conditional features; see `18_IMPLEMENTATION_STATUS.md` for the boundary.

**Infrastructure premise:** PostgreSQL host/runtime, Redis, n8n, Media Storage, reverse proxy/TLS, and host-level service management already exist outside this application repository. Tasks below integrate with those services; they do not reinstall or duplicate them.

## Phase 0 — Planning freeze and decisions

- [x] Define product as multi-tenant AI business automation SaaS.
- [x] Select PostgreSQL as primary database.
- [x] Separate `app_db` from n8n internal DB.
- [x] Remove Google Sheets from target architecture.
- [x] Define Customer Panel and Super Admin Panel roles.
- [x] Define Redis, queues/workers, Media Storage, pgvector, n8n boundaries.
- [x] Define dynamic collections instead of product-only schema.
- [x] Define multi-business/multi-channel/shared-catalog model.
- [x] Define AI providers, agents, prompt training/versioning.
- [x] Define messaging/media reuse/rate-limit architecture.
- [x] Confirm PostgreSQL/Redis/n8n/Media Storage infrastructure is pre-provisioned and external to this repository.
- [x] Document Media Storage user API capabilities and integration model.
- [x] Define n8n JSON workflow bundle/import/update/rollback model.
- [x] Review and approve all files in `docs/`.
- [x] Select backend framework/service layout.
- [x] Select ORM/query layer while preserving PostgreSQL contracts.
- [x] Select Redis queue library/runtime.
- [x] Decide production auth implementation/library while preserving auth contracts.
- [ ] Confirm exact deployed n8n version before implementing automated workflow deployment.

## Phase 1 — Repository/application foundation

### Project structure
- [x] Establish shared TypeScript packages/types as needed.
- [x] Add backend/API service.
- [x] Add worker service(s).
- [x] Establish environment validation/config package.
- [x] Add lint/typecheck/test commands across services.
- [x] Add CI for docs/typecheck/tests/build.

### Existing infrastructure client integration
- [x] Add application PostgreSQL client configuration.
- [x] Create/migrate `app_db` using application migrations; do not install PostgreSQL.
- [x] Verify separate n8n internal DB remains n8n-owned.
- [x] Enable/verify pgvector in `app_db` before vector features are used.
- [x] Add Redis client configuration using an application/environment namespace; do not install Redis.
- [x] Add Media Storage adapter configuration; do not install Media Storage.
- [x] Add internal service-auth configuration for n8n/workers.
- [x] Add health/readiness checks for required external services.
- [x] Define environment-specific configuration without hard-coded infrastructure URLs.

### Database base
- [x] Create migration system.
- [x] Add UUID/ID strategy.
- [x] Add timestamps/version conventions.
- [x] Add tenant-scoped query conventions.
- [x] Add outbox/event tables.
- [x] Add audit infrastructure.
- [x] Add automation deployment metadata table/model.

## Phase 2 — Authentication, tenancy, and RBAC

- [x] Implement `users`.
- [x] Implement signup.
- [x] Email verification.
- [x] Signin/signout.
- [x] Password reset/change.
- [x] Session storage/revocation.
- [x] Login abuse rate limiting.
- [x] Implement `tenants`.
- [x] Implement memberships/invitations.
- [x] Roles: OWNER/ADMIN/STAFF/VIEWER.
- [x] Business-level membership restriction support.
- [x] Server-side permission middleware/policies.
- [x] Platform admin identities/roles separated from tenant roles.
- [x] Super-admin stronger session/MFA policy.
- [x] Security event logging.
- [x] Tenant-isolation tests.

## Phase 3 — Business and channel domain

- [x] Implement businesses CRUD.
- [x] Business timezone/currency/locale/default settings.
- [x] Implement channel account model.
- [x] Implement encrypted channel credentials.
- [x] Facebook Page connection flow.
- [x] Instagram account connection flow.
- [x] WhatsApp connection flow.
- [x] OAuth state/nonce verification.
- [x] Connection test/reconnect state.
- [x] Channel active/pause/disconnect.
- [x] Channel API version metadata.
- [x] Channel health metrics.
- [x] Customer Panel business/channel screens.
- [x] Super Admin cross-tenant business/channel screens.

## Phase 4 — Dynamic data engine

- [x] Implement collections.
- [x] Implement collection field definitions.
- [x] Implement field types and validation.
- [x] Implement JSONB collection items.
- [x] Implement search/filter/sort allowlist.
- [x] Implement collection templates: Product, Service, Property, Menu/Package, Blank.
- [x] Implement item CRUD/table editor.
- [x] Implement collection-channel many-to-many links.
- [x] Implement channel-specific item overrides.
- [x] Implement relationship/reference fields safely.
- [x] Implement schema version/concurrency protection.
- [x] Implement import/export jobs when scheduled.
- [x] Add indexes based on actual query patterns.
- [x] Ensure no tenant-created physical DB tables/columns.

## Phase 5 — Existing Media Storage integration

### Tenant storage identity
- [x] Implement `tenant_media_accounts`.
- [x] Define automated/internal provisioning flow for one Media Storage user per SaaS tenant.
- [x] Encrypt/reference tenant Media Storage bearer credentials.
- [x] Map plan/storage quota policy to Media Storage user quota where applicable.
- [x] Implement credential rotation/revocation handling.

### Storage adapter
- [x] Implement usage call.
- [x] Implement multipart upload (`file`, `visibility`).
- [x] Implement list/pagination.
- [x] Implement metadata read.
- [x] Implement authenticated binary content read/stream.
- [x] Implement private/public visibility update.
- [x] Implement hard delete.
- [x] Implement structured quota/file/not-found/service errors.
- [x] Ensure adapter resolves configured base URL; domain code does not construct infrastructure URLs.

### SaaS media domain
- [x] Implement `media_assets` external file/user ID mapping.
- [x] Persist MIME/kind/size/visibility/SHA-256 metadata.
- [x] Collection item media/gallery links.
- [x] Message/training media links.
- [x] Media library UI.
- [x] Tenant-scoped checksum deduplication policy.
- [x] Additional dimensions/duration/thumbnail processing as needed.
- [x] Reference-aware deletion/grace period.
- [x] Private-by-default policy for conversation/training files.
- [x] Approved public-media policy for catalog/provider fetching.
- [x] Reconcile application quota with Media Storage quota errors.
- [ ] Document/verify media backup dependency: service metadata DB + physical bytes.

## Phase 6 — Redis, queues, workers

- [x] Configure Redis client against existing service.
- [x] Define application/environment key prefix.
- [x] Select queue library.
- [x] Define job envelope/types.
- [x] Inbound processing queue.
- [x] Outbound messaging queue.
- [x] Media queue.
- [x] Training queue.
- [x] Embedding queue.
- [x] Follow-up queue.
- [x] Analytics/maintenance queues.
- [x] Retry/backoff/jitter policy.
- [x] Dead-letter handling.
- [x] Worker graceful shutdown.
- [x] Worker heartbeats/metrics.
- [x] Tenant fairness/concurrency controls.
- [x] Distributed locks with TTL/ownership tokens.
- [x] Queue administration in Super Admin.
- [x] Redis-loss/outbox recovery behavior.

## Phase 7 — Conversation and webhook platform

- [x] Implement contacts.
- [x] Implement conversations.
- [x] Implement transport messages.
- [x] Implement logical conversation turns.
- [x] Message media links.
- [x] Meta webhook verification.
- [x] Provider signature validation.
- [x] Normalize FB/IG/WA events.
- [x] Resolve receiving account to tenant/business/channel.
- [x] Durable inbound idempotency.
- [x] Persist then enqueue/ack quickly.
- [x] Implement Redis message aggregation window.
- [x] Maximum aggregation count/bytes/time.
- [x] HUMAN/AI conversation modes.
- [x] Staff takeover/resume.
- [x] Detect manual Page-owner replies without mistaking API echoes.
- [x] Unified Customer Panel inbox.
- [x] Delivery/read/error statuses where available.

## Phase 8 — Outbound messaging gateway

- [x] Define provider-neutral response plan.
- [x] Facebook adapter.
- [x] Instagram adapter.
- [x] WhatsApp adapter.
- [x] Outbound job idempotency.
- [x] Priority scheduling.
- [x] Provider/global/plan/customer/contact rate-limit resolution.
- [x] Redis atomic rate limiter.
- [x] Burst limits.
- [x] Media limits/images per response.
- [x] Retry classification.
- [x] Dead-letter delivery state.
- [x] Persist final outbound message/provider IDs.
- [x] Channel reconnect behavior.
- [x] Super Admin delivery diagnostics.

## Phase 9 — Media delivery optimization

- [x] Implement `channel_media_cache`.
- [x] Reuse Facebook attachment IDs when supported.
- [x] Reuse WhatsApp/other remote media IDs according to provider rules.
- [x] Detect stale/expired remote ID.
- [x] Lock concurrent refresh/upload.
- [x] Fetch authenticated binary from Media Storage when private.
- [x] Use approved public URL only where allowed/useful.
- [x] Re-upload and update remote mapping.
- [x] Multi-image response batching.
- [x] Continuation behavior when requested image count exceeds limit.
- [x] Track cache hit/miss/reupload metrics.

## Phase 10 — AI provider and model platform

- [x] Implement encrypted AI provider connections.
- [x] Platform-owned and BYOK modes.
- [x] OpenAI adapter.
- [x] Anthropic adapter.
- [x] Gemini adapter.
- [x] OpenAI-compatible adapter with SSRF controls.
- [x] Provider connection test.
- [x] Model registry/capability metadata.
- [x] Task-specific model configs.
- [x] DEFAULT_CHAT routing.
- [x] INTENT_CLASSIFICATION routing.
- [x] IMAGE_ANALYSIS routing.
- [x] AUDIO_TRANSCRIPTION routing.
- [x] STRUCTURED_EXTRACTION routing.
- [x] PROMPT_SYNTHESIS routing.
- [x] EMBEDDINGS routing.
- [x] Provider fallback policy.
- [x] AI usage/tokens/cost logging.

## Phase 11 — AI agents and capabilities

- [x] Implement agent profiles.
- [x] Agent/business/channel links.
- [x] Capability definitions.
- [x] Data/collection links.
- [x] Prompt sections.
- [x] Prompt version lifecycle.
- [x] Prompt publish/rollback.
- [x] Active prompt cache/invalidation.
- [x] Agent test simulator.
- [x] Tool/action schema validation.
- [x] Grounding rules and missing-data behavior.
- [x] Customer Panel agent editor.
- [x] Super Admin platform template controls.

## Phase 12 — Vision/audio and multimodal runtime

- [x] Inbound screenshot/image media ingestion into Media Storage.
- [x] Vision model bounded batching.
- [x] Structured observation output.
- [x] Match/search attached business collections.
- [x] Ensure live DB price/stock overrides vision assumptions.
- [x] Multiple screenshot logical turn.
- [x] Audio ingestion/transcription.
- [x] Transcript provenance/status.
- [x] Model/file/cost controls.

## Phase 13 — RAG / pgvector knowledge

- [x] Enable vector schema/indexes.
- [x] Knowledge source model.
- [x] Chunking service.
- [x] Embedding jobs.
- [x] Source/version tracking.
- [x] Tenant/business-scoped vector query.
- [x] Hybrid structured + vector retrieval.
- [x] Re-index on source change.
- [x] Delete/deactivate stale chunks.
- [x] Knowledge management UI.
- [x] Indexing status/error UI.

## Phase 14 — Training Studio

- [x] Implement trainer identities.
- [x] Facebook trainer user/profile routing.
- [x] WhatsApp trainer number routing.
- [x] Instagram trainer support where reliable.
- [x] Panel simulator training examples.
- [x] Training sessions/examples.
- [x] Training media stored privately by default.
- [x] Approval/rejection of examples.
- [x] Prompt synthesis job.
- [x] Input source/version capture.
- [x] Candidate prompt version.
- [x] Automated validation/regression checks.
- [x] Candidate diff UI.
- [x] Sandbox test UI.
- [x] Publish/discard/rollback.
- [x] Optional explicitly enabled auto-publish policy.
- [x] Training usage/cost analytics.

## Phase 15 — Business action capabilities

### Orders
- [x] Orders/order items schema.
- [x] Historical item snapshots.
- [x] Create-order internal API with idempotency.
- [x] Status workflow.
- [x] Customer Panel Orders UI.
- [x] Source channel/conversation links.

### Bookings/appointments
- [x] Booking schema/state transitions.
- [x] Availability/provider integration contract if needed.
- [x] Create/reschedule/cancel validation.
- [x] UI.

### Leads
- [x] Lead schema/stages/assignment.
- [x] Capture tool.
- [x] UI.

### Additional capabilities
- [x] Quote request.
- [x] Support case/ticket.
- [x] Payment/delivery instructions.
- [x] Capability-specific templates/regression tests.

## Phase 16 — Follow-ups and automation schedules

- [x] Follow-up policy per agent/channel.
- [x] Due-job scheduling.
- [x] HUMAN mode guard.
- [x] Recent-response invalidation.
- [x] Messaging-window/provider policy guard.
- [x] Rate/plan limit guard.
- [x] Idempotent send.
- [x] Customer controls.
- [x] Super Admin monitoring.

## Phase 17 — Analytics, metering, limits

- [x] Usage event schema.
- [x] Message/turn/AI/media/action event emitters.
- [x] Hourly/daily rollups.
- [x] Customer channel analytics.
- [x] AI token/cost analytics.
- [x] Media Storage bytes/quota/cache analytics.
- [x] Business outcome analytics.
- [x] Plan definitions/features.
- [x] Hard/soft/budget/rate-limit engine.
- [x] Effective-limit resolver.
- [x] Redis fast counters + PostgreSQL reconciliation.
- [x] Quota alerts.
- [x] Super Admin usage/cost dashboards.

## Phase 18 — Billing readiness / optional payment integration

- [x] Plans/prices/subscriptions model.
- [x] Plan assignment/change lifecycle.
- [x] Trial/credit model if required.
- [x] Usage billing record model.
- [ ] Payment provider integration when selected.
- [x] Invoice/payment history UI.
- [x] Overage policy.
- [x] Platform-paid AI budget enforcement.
- [x] Storage quota/billing mapping if storage becomes plan-metered.

## Phase 19 — n8n workflow bundle implementation and delivery

### Workflow files
- [x] Create `automation/n8n/manifest.json`.
- [x] Create modular JSON workflows rather than one giant workflow.
- [x] Meta webhook gateway workflow.
- [x] Inbound conversation workflow.
- [x] Agent runtime workflow.
- [x] Multimodal workflow.
- [x] Training workflow.
- [x] Follow-up workflow.
- [x] Health/maintenance workflow where needed.

### Portability/security
- [x] Remove secrets/customer data from exports.
- [x] Remove hard-coded infrastructure URLs where configuration can be used.
- [x] Minimize environment-specific credential-ID coupling.
- [x] Define required platform/internal credential aliases.
- [x] Validate JSON exports in CI.
- [x] Record bundle/API contract/n8n compatibility version.

### Existing n8n import/cutover
- [ ] Import JSON bundle into existing n8n runtime while inactive.
- [ ] Bind environment-specific credentials/settings.
- [ ] Verify webhook path/schedule conflicts.
- [ ] Execute manual/staging tests.
- [ ] Record target workflow IDs + bundle version in deployment metadata.
- [ ] Perform blue/green cutover for major changes.
- [ ] Preserve previous compatible bundle for rollback window.
- [x] Add Super Admin expected/deployed workflow version health view.

### Later automation
- [x] After n8n version is pinned/verified, implement supported API/CLI deployment tool.
- [x] Add manifest validation/dry-run/diff where feasible.
- [x] Prevent partial conflicting trigger activation.

## Phase 20 — Super Admin completion

- [x] Platform dashboard.
- [x] Tenant/user support screens.
- [x] Tenant suspension/reactivation.
- [x] Plan/limit overrides.
- [x] Channel health/reconnect diagnostics.
- [x] Queue/job/dead-letter operations.
- [x] n8n workflow health/version view.
- [x] Redis/Postgres/Media/worker application-health summaries.
- [x] Feature flags.
- [x] Audit/security console.
- [ ] Scoped impersonation/support view if approved.
- [x] Dangerous-action re-authentication.

## Phase 21 — Security hardening

- [x] Secret encryption/key rotation.
- [x] Super Admin MFA.
- [x] CSRF/security headers.
- [x] SSRF protection for custom provider URLs.
- [x] Media upload hardening/policy validation in addition to service validation.
- [ ] Tenant RLS defense-in-depth where selected.
- [ ] API authorization penetration tests.
- [x] Webhook signature tests.
- [x] Rate-limit abuse tests.
- [x] Audit coverage review.
- [x] Privacy/retention implementation.
- [x] Customer export/delete workflows.
- [x] Verify Media Storage credentials never reach browsers/logs.
- [x] Verify n8n workflow JSON contains no secrets.

## Phase 22 — Reliability/observability

- [x] Structured logging.
- [x] Correlation IDs end to end.
- [x] API metrics.
- [x] app DB/Redis client metrics.
- [x] queue depth/age/throughput.
- [x] worker heartbeat.
- [x] n8n workflow execution/bundle health.
- [x] provider error dashboards.
- [x] Media Storage integration errors/quota health.
- [x] cost anomaly alerts.
- [x] health/readiness endpoints.
- [x] circuit/degraded behavior where appropriate.
- [x] runbooks.

## Phase 23 — Backups and disaster recovery

- [ ] Automated/verified `app_db` backups through approved infrastructure process.
- [ ] Confirm n8n internal backup ownership/procedure.
- [x] Keep workflow JSON bundle/version in Git independent of n8n DB backup.
- [ ] Confirm Media Storage backup includes both service metadata DB and physical bytes.
- [ ] Backup encryption/off-host copy as infrastructure policy requires.
- [ ] Restore test.
- [x] Define RPO/RTO.
- [x] Queue/Redis loss recovery procedure.
- [x] Provider webhook reconciliation procedure.
- [ ] Disaster runbook exercise.

## Phase 24 — Behavioral migration from earlier prototype

- [x] Inventory reusable behavior, not infrastructure/repository dependencies.
- [x] Rebuild spreadsheet-based config reads to SaaS API/DB reads.
- [x] Remove Control Spreadsheet workflows.
- [x] Remove Operations Spreadsheet workflows.
- [x] Migrate Meta routing behavior.
- [x] Migrate human handoff/echo protection.
- [x] Migrate follow-up guards.
- [x] Migrate image/screenshot behavior.
- [x] Migrate reusable Facebook attachment behavior into generic media layer.
- [x] Migrate dynamic AI task routing.
- [x] Validate expected behavior with new regression suite.

## Phase 25 — Production launch

- [ ] Staging full end-to-end test.
- [ ] Load/burst tests.
- [ ] Tenant isolation/security signoff.
- [ ] Production application secrets/config injected.
- [ ] Meta production permissions/app review as required.
- [ ] Infrastructure dependencies pass health/readiness checks.
- [ ] Backups/alerts verified with infrastructure owners.
- [ ] Super Admin MFA enforced.
- [ ] Queue/dead-letter recovery verified.
- [ ] n8n production workflow bundle version verified.
- [ ] Media Storage tenant mappings/quota behavior verified.
- [ ] Customer onboarding tested from zero application configuration.
- [x] Operational runbook ready.
- [ ] Controlled pilot tenants.
- [ ] Monitor errors/costs/latency.
- [ ] General release after pilot criteria pass.

## Definition of done for any feature

A feature is not done until it has:

- tenant authorization.
- validation.
- idempotency where retryable.
- audit coverage where sensitive.
- usage/metrics where operationally relevant.
- error/empty/loading states in UI.
- tests at appropriate levels.
- documentation updated.
- migration/rollback considerations.
- observability for production diagnosis.
- no hard-coded infrastructure-admin dependencies.
- no secret-bearing n8n workflow artifact changes.