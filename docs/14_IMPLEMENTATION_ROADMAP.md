# Implementation roadmap and complete task plan

This file is the delivery checklist. Runtime coding starts only after the documentation is accepted. Tasks are ordered to reduce rework and establish security/data foundations before automation complexity.

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
- [ ] Review and approve all files in `docs/`.
- [ ] Select backend framework/service layout.
- [ ] Select ORM/query layer while preserving PostgreSQL contracts.
- [ ] Select Redis queue library/runtime.
- [ ] Decide production auth implementation/library while preserving auth contracts.
- [ ] Confirm exact deployed n8n version before implementing automated workflow deployment.

## Phase 1 — Repository/application foundation

### Project structure
- [ ] Establish shared TypeScript packages/types as needed.
- [ ] Add backend/API service.
- [ ] Add worker service(s).
- [ ] Establish environment validation/config package.
- [ ] Add lint/typecheck/test commands across services.
- [ ] Add CI for docs/typecheck/tests/build.

### Existing infrastructure client integration
- [ ] Add application PostgreSQL client configuration.
- [ ] Create/migrate `app_db` using application migrations; do not install PostgreSQL.
- [ ] Verify separate n8n internal DB remains n8n-owned.
- [ ] Enable/verify pgvector in `app_db` before vector features are used.
- [ ] Add Redis client configuration using an application/environment namespace; do not install Redis.
- [ ] Add Media Storage adapter configuration; do not install Media Storage.
- [ ] Add internal service-auth configuration for n8n/workers.
- [ ] Add health/readiness checks for required external services.
- [ ] Define environment-specific configuration without hard-coded infrastructure URLs.

### Database base
- [ ] Create migration system.
- [ ] Add UUID/ID strategy.
- [ ] Add timestamps/version conventions.
- [ ] Add tenant-scoped query conventions.
- [ ] Add outbox/event tables.
- [ ] Add audit infrastructure.
- [ ] Add automation deployment metadata table/model.

## Phase 2 — Authentication, tenancy, and RBAC

- [ ] Implement `users`.
- [ ] Implement signup.
- [ ] Email verification.
- [ ] Signin/signout.
- [ ] Password reset/change.
- [ ] Session storage/revocation.
- [ ] Login abuse rate limiting.
- [ ] Implement `tenants`.
- [ ] Implement memberships/invitations.
- [ ] Roles: OWNER/ADMIN/STAFF/VIEWER.
- [ ] Business-level membership restriction support.
- [ ] Server-side permission middleware/policies.
- [ ] Platform admin identities/roles separated from tenant roles.
- [ ] Super-admin stronger session/MFA policy.
- [ ] Security event logging.
- [ ] Tenant-isolation tests.

## Phase 3 — Business and channel domain

- [ ] Implement businesses CRUD.
- [ ] Business timezone/currency/locale/default settings.
- [ ] Implement channel account model.
- [ ] Implement encrypted channel credentials.
- [ ] Facebook Page connection flow.
- [ ] Instagram account connection flow.
- [ ] WhatsApp connection flow.
- [ ] OAuth state/nonce verification.
- [ ] Connection test/reconnect state.
- [ ] Channel active/pause/disconnect.
- [ ] Channel API version metadata.
- [ ] Channel health metrics.
- [ ] Customer Panel business/channel screens.
- [ ] Super Admin cross-tenant business/channel screens.

## Phase 4 — Dynamic data engine

- [ ] Implement collections.
- [ ] Implement collection field definitions.
- [ ] Implement field types and validation.
- [ ] Implement JSONB collection items.
- [ ] Implement search/filter/sort allowlist.
- [ ] Implement collection templates: Product, Service, Property, Menu/Package, Blank.
- [ ] Implement item CRUD/table editor.
- [ ] Implement collection-channel many-to-many links.
- [ ] Implement channel-specific item overrides.
- [ ] Implement relationship/reference fields safely.
- [ ] Implement schema version/concurrency protection.
- [ ] Implement import/export jobs when scheduled.
- [ ] Add indexes based on actual query patterns.
- [ ] Ensure no tenant-created physical DB tables/columns.

## Phase 5 — Existing Media Storage integration

### Tenant storage identity
- [ ] Implement `tenant_media_accounts`.
- [ ] Define automated/internal provisioning flow for one Media Storage user per SaaS tenant.
- [ ] Encrypt/reference tenant Media Storage bearer credentials.
- [ ] Map plan/storage quota policy to Media Storage user quota where applicable.
- [ ] Implement credential rotation/revocation handling.

### Storage adapter
- [ ] Implement usage call.
- [ ] Implement multipart upload (`file`, `visibility`).
- [ ] Implement list/pagination.
- [ ] Implement metadata read.
- [ ] Implement authenticated binary content read/stream.
- [ ] Implement private/public visibility update.
- [ ] Implement hard delete.
- [ ] Implement structured quota/file/not-found/service errors.
- [ ] Ensure adapter resolves configured base URL; domain code does not construct infrastructure URLs.

### SaaS media domain
- [ ] Implement `media_assets` external file/user ID mapping.
- [ ] Persist MIME/kind/size/visibility/SHA-256 metadata.
- [ ] Collection item media/gallery links.
- [ ] Message/training media links.
- [ ] Media library UI.
- [ ] Tenant-scoped checksum deduplication policy.
- [ ] Additional dimensions/duration/thumbnail processing as needed.
- [ ] Reference-aware deletion/grace period.
- [ ] Private-by-default policy for conversation/training files.
- [ ] Approved public-media policy for catalog/provider fetching.
- [ ] Reconcile application quota with Media Storage quota errors.
- [ ] Document/verify media backup dependency: service metadata DB + physical bytes.

## Phase 6 — Redis, queues, workers

- [ ] Configure Redis client against existing service.
- [ ] Define application/environment key prefix.
- [ ] Select queue library.
- [ ] Define job envelope/types.
- [ ] Inbound processing queue.
- [ ] Outbound messaging queue.
- [ ] Media queue.
- [ ] Training queue.
- [ ] Embedding queue.
- [ ] Follow-up queue.
- [ ] Analytics/maintenance queues.
- [ ] Retry/backoff/jitter policy.
- [ ] Dead-letter handling.
- [ ] Worker graceful shutdown.
- [ ] Worker heartbeats/metrics.
- [ ] Tenant fairness/concurrency controls.
- [ ] Distributed locks with TTL/ownership tokens.
- [ ] Queue administration in Super Admin.
- [ ] Redis-loss/outbox recovery behavior.

## Phase 7 — Conversation and webhook platform

- [ ] Implement contacts.
- [ ] Implement conversations.
- [ ] Implement transport messages.
- [ ] Implement logical conversation turns.
- [ ] Message media links.
- [ ] Meta webhook verification.
- [ ] Provider signature validation.
- [ ] Normalize FB/IG/WA events.
- [ ] Resolve receiving account to tenant/business/channel.
- [ ] Durable inbound idempotency.
- [ ] Persist then enqueue/ack quickly.
- [ ] Implement Redis message aggregation window.
- [ ] Maximum aggregation count/bytes/time.
- [ ] HUMAN/AI conversation modes.
- [ ] Staff takeover/resume.
- [ ] Detect manual Page-owner replies without mistaking API echoes.
- [ ] Unified Customer Panel inbox.
- [ ] Delivery/read/error statuses where available.

## Phase 8 — Outbound messaging gateway

- [ ] Define provider-neutral response plan.
- [ ] Facebook adapter.
- [ ] Instagram adapter.
- [ ] WhatsApp adapter.
- [ ] Outbound job idempotency.
- [ ] Priority scheduling.
- [ ] Provider/global/plan/customer/contact rate-limit resolution.
- [ ] Redis atomic rate limiter.
- [ ] Burst limits.
- [ ] Media limits/images per response.
- [ ] Retry classification.
- [ ] Dead-letter delivery state.
- [ ] Persist final outbound message/provider IDs.
- [ ] Channel reconnect behavior.
- [ ] Super Admin delivery diagnostics.

## Phase 9 — Media delivery optimization

- [ ] Implement `channel_media_cache`.
- [ ] Reuse Facebook attachment IDs when supported.
- [ ] Reuse WhatsApp/other remote media IDs according to provider rules.
- [ ] Detect stale/expired remote ID.
- [ ] Lock concurrent refresh/upload.
- [ ] Fetch authenticated binary from Media Storage when private.
- [ ] Use approved public URL only where allowed/useful.
- [ ] Re-upload and update remote mapping.
- [ ] Multi-image response batching.
- [ ] Continuation behavior when requested image count exceeds limit.
- [ ] Track cache hit/miss/reupload metrics.

## Phase 10 — AI provider and model platform

- [ ] Implement encrypted AI provider connections.
- [ ] Platform-owned and BYOK modes.
- [ ] OpenAI adapter.
- [ ] Anthropic adapter.
- [ ] Gemini adapter.
- [ ] OpenAI-compatible adapter with SSRF controls.
- [ ] Provider connection test.
- [ ] Model registry/capability metadata.
- [ ] Task-specific model configs.
- [ ] DEFAULT_CHAT routing.
- [ ] INTENT_CLASSIFICATION routing.
- [ ] IMAGE_ANALYSIS routing.
- [ ] AUDIO_TRANSCRIPTION routing.
- [ ] STRUCTURED_EXTRACTION routing.
- [ ] PROMPT_SYNTHESIS routing.
- [ ] EMBEDDINGS routing.
- [ ] Provider fallback policy.
- [ ] AI usage/tokens/cost logging.

## Phase 11 — AI agents and capabilities

- [ ] Implement agent profiles.
- [ ] Agent/business/channel links.
- [ ] Capability definitions.
- [ ] Data/collection links.
- [ ] Prompt sections.
- [ ] Prompt version lifecycle.
- [ ] Prompt publish/rollback.
- [ ] Active prompt cache/invalidation.
- [ ] Agent test simulator.
- [ ] Tool/action schema validation.
- [ ] Grounding rules and missing-data behavior.
- [ ] Customer Panel agent editor.
- [ ] Super Admin platform template controls.

## Phase 12 — Vision/audio and multimodal runtime

- [ ] Inbound screenshot/image media ingestion into Media Storage.
- [ ] Vision model bounded batching.
- [ ] Structured observation output.
- [ ] Match/search attached business collections.
- [ ] Ensure live DB price/stock overrides vision assumptions.
- [ ] Multiple screenshot logical turn.
- [ ] Audio ingestion/transcription.
- [ ] Transcript provenance/status.
- [ ] Model/file/cost controls.

## Phase 13 — RAG / pgvector knowledge

- [ ] Enable vector schema/indexes.
- [ ] Knowledge source model.
- [ ] Chunking service.
- [ ] Embedding jobs.
- [ ] Source/version tracking.
- [ ] Tenant/business-scoped vector query.
- [ ] Hybrid structured + vector retrieval.
- [ ] Re-index on source change.
- [ ] Delete/deactivate stale chunks.
- [ ] Knowledge management UI.
- [ ] Indexing status/error UI.

## Phase 14 — Training Studio

- [ ] Implement trainer identities.
- [ ] Facebook trainer user/profile routing.
- [ ] WhatsApp trainer number routing.
- [ ] Instagram trainer support where reliable.
- [ ] Panel simulator training examples.
- [ ] Training sessions/examples.
- [ ] Training media stored privately by default.
- [ ] Approval/rejection of examples.
- [ ] Prompt synthesis job.
- [ ] Input source/version capture.
- [ ] Candidate prompt version.
- [ ] Automated validation/regression checks.
- [ ] Candidate diff UI.
- [ ] Sandbox test UI.
- [ ] Publish/discard/rollback.
- [ ] Optional explicitly enabled auto-publish policy.
- [ ] Training usage/cost analytics.

## Phase 15 — Business action capabilities

### Orders
- [ ] Orders/order items schema.
- [ ] Historical item snapshots.
- [ ] Create-order internal API with idempotency.
- [ ] Status workflow.
- [ ] Customer Panel Orders UI.
- [ ] Source channel/conversation links.

### Bookings/appointments
- [ ] Booking schema/state transitions.
- [ ] Availability/provider integration contract if needed.
- [ ] Create/reschedule/cancel validation.
- [ ] UI.

### Leads
- [ ] Lead schema/stages/assignment.
- [ ] Capture tool.
- [ ] UI.

### Additional capabilities
- [ ] Quote request.
- [ ] Support case/ticket.
- [ ] Payment/delivery instructions.
- [ ] Capability-specific templates/regression tests.

## Phase 16 — Follow-ups and automation schedules

- [ ] Follow-up policy per agent/channel.
- [ ] Due-job scheduling.
- [ ] HUMAN mode guard.
- [ ] Recent-response invalidation.
- [ ] Messaging-window/provider policy guard.
- [ ] Rate/plan limit guard.
- [ ] Idempotent send.
- [ ] Customer controls.
- [ ] Super Admin monitoring.

## Phase 17 — Analytics, metering, limits

- [ ] Usage event schema.
- [ ] Message/turn/AI/media/action event emitters.
- [ ] Hourly/daily rollups.
- [ ] Customer channel analytics.
- [ ] AI token/cost analytics.
- [ ] Media Storage bytes/quota/cache analytics.
- [ ] Business outcome analytics.
- [ ] Plan definitions/features.
- [ ] Hard/soft/budget/rate-limit engine.
- [ ] Effective-limit resolver.
- [ ] Redis fast counters + PostgreSQL reconciliation.
- [ ] Quota alerts.
- [ ] Super Admin usage/cost dashboards.

## Phase 18 — Billing readiness / optional payment integration

- [ ] Plans/prices/subscriptions model.
- [ ] Plan assignment/change lifecycle.
- [ ] Trial/credit model if required.
- [ ] Usage billing record model.
- [ ] Payment provider integration when selected.
- [ ] Invoice/payment history UI.
- [ ] Overage policy.
- [ ] Platform-paid AI budget enforcement.
- [ ] Storage quota/billing mapping if storage becomes plan-metered.

## Phase 19 — n8n workflow bundle implementation and delivery

### Workflow files
- [ ] Create `automation/n8n/manifest.json`.
- [ ] Create modular JSON workflows rather than one giant workflow.
- [ ] Meta webhook gateway workflow.
- [ ] Inbound conversation workflow.
- [ ] Agent runtime workflow.
- [ ] Multimodal workflow.
- [ ] Training workflow.
- [ ] Follow-up workflow.
- [ ] Health/maintenance workflow where needed.

### Portability/security
- [ ] Remove secrets/customer data from exports.
- [ ] Remove hard-coded infrastructure URLs where configuration can be used.
- [ ] Minimize environment-specific credential-ID coupling.
- [ ] Define required platform/internal credential aliases.
- [ ] Validate JSON exports in CI.
- [ ] Record bundle/API contract/n8n compatibility version.

### Existing n8n import/cutover
- [ ] Import JSON bundle into existing n8n runtime while inactive.
- [ ] Bind environment-specific credentials/settings.
- [ ] Verify webhook path/schedule conflicts.
- [ ] Execute manual/staging tests.
- [ ] Record target workflow IDs + bundle version in deployment metadata.
- [ ] Perform blue/green cutover for major changes.
- [ ] Preserve previous compatible bundle for rollback window.
- [ ] Add Super Admin expected/deployed workflow version health view.

### Later automation
- [ ] After n8n version is pinned/verified, implement supported API/CLI deployment tool.
- [ ] Add manifest validation/dry-run/diff where feasible.
- [ ] Prevent partial conflicting trigger activation.

## Phase 20 — Super Admin completion

- [ ] Platform dashboard.
- [ ] Tenant/user support screens.
- [ ] Tenant suspension/reactivation.
- [ ] Plan/limit overrides.
- [ ] Channel health/reconnect diagnostics.
- [ ] Queue/job/dead-letter operations.
- [ ] n8n workflow health/version view.
- [ ] Redis/Postgres/Media/worker application-health summaries.
- [ ] Feature flags.
- [ ] Audit/security console.
- [ ] Scoped impersonation/support view if approved.
- [ ] Dangerous-action re-authentication.

## Phase 21 — Security hardening

- [ ] Secret encryption/key rotation.
- [ ] Super Admin MFA.
- [ ] CSRF/security headers.
- [ ] SSRF protection for custom provider URLs.
- [ ] Media upload hardening/policy validation in addition to service validation.
- [ ] Tenant RLS defense-in-depth where selected.
- [ ] API authorization penetration tests.
- [ ] Webhook signature tests.
- [ ] Rate-limit abuse tests.
- [ ] Audit coverage review.
- [ ] Privacy/retention implementation.
- [ ] Customer export/delete workflows.
- [ ] Verify Media Storage credentials never reach browsers/logs.
- [ ] Verify n8n workflow JSON contains no secrets.

## Phase 22 — Reliability/observability

- [ ] Structured logging.
- [ ] Correlation IDs end to end.
- [ ] API metrics.
- [ ] app DB/Redis client metrics.
- [ ] queue depth/age/throughput.
- [ ] worker heartbeat.
- [ ] n8n workflow execution/bundle health.
- [ ] provider error dashboards.
- [ ] Media Storage integration errors/quota health.
- [ ] cost anomaly alerts.
- [ ] health/readiness endpoints.
- [ ] circuit/degraded behavior where appropriate.
- [ ] runbooks.

## Phase 23 — Backups and disaster recovery

- [ ] Automated/verified `app_db` backups through approved infrastructure process.
- [ ] Confirm n8n internal backup ownership/procedure.
- [ ] Keep workflow JSON bundle/version in Git independent of n8n DB backup.
- [ ] Confirm Media Storage backup includes both service metadata DB and physical bytes.
- [ ] Backup encryption/off-host copy as infrastructure policy requires.
- [ ] Restore test.
- [ ] Define RPO/RTO.
- [ ] Queue/Redis loss recovery procedure.
- [ ] Provider webhook reconciliation procedure.
- [ ] Disaster runbook exercise.

## Phase 24 — Behavioral migration from earlier prototype

- [ ] Inventory reusable behavior, not infrastructure/repository dependencies.
- [ ] Rebuild spreadsheet-based config reads to SaaS API/DB reads.
- [ ] Remove Control Spreadsheet workflows.
- [ ] Remove Operations Spreadsheet workflows.
- [ ] Migrate Meta routing behavior.
- [ ] Migrate human handoff/echo protection.
- [ ] Migrate follow-up guards.
- [ ] Migrate image/screenshot behavior.
- [ ] Migrate reusable Facebook attachment behavior into generic media layer.
- [ ] Migrate dynamic AI task routing.
- [ ] Validate expected behavior with new regression suite.

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
- [ ] Operational runbook ready.
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