# Implementation roadmap and complete task plan

This file is the delivery checklist. Runtime coding starts only after the documentation is accepted. Tasks are ordered to reduce rework and to establish security/data foundations before automation complexity.

## Phase 0 — Planning freeze and decisions

- [x] Define product as multi-tenant AI business automation SaaS.
- [x] Select PostgreSQL as primary database.
- [x] Separate `app_db` from n8n internal DB.
- [x] Remove Google Sheets from target architecture.
- [x] Define Customer Panel and Super Admin Panel roles.
- [x] Define Redis, queues/workers, media storage, pgvector, n8n.
- [x] Define dynamic collections instead of product-only schema.
- [x] Define multi-business/multi-channel/shared-catalog model.
- [x] Define AI providers, agents, prompt training/versioning.
- [x] Define messaging/media reuse/rate-limit architecture.
- [ ] Review and approve all files in `docs/`.
- [ ] Select backend framework/service layout.
- [ ] Select ORM/query layer while preserving PostgreSQL contracts.
- [ ] Select Redis queue library/runtime.
- [ ] Document actual API contract of `admin.openmusk.store/media` and close capability gaps.
- [ ] Decide production auth implementation/library while preserving auth contracts.

## Phase 1 — Repository/application foundation

### Project structure
- [ ] Establish shared TypeScript packages/types as needed.
- [ ] Add backend/API service.
- [ ] Add worker service(s).
- [ ] Establish environment validation/config package.
- [ ] Add lint/typecheck/test commands across services.
- [ ] Add CI for docs/typecheck/tests/build.

### Local infrastructure
- [ ] Add PostgreSQL development service.
- [ ] Create separate `app_db` and `n8n_db`.
- [ ] Enable pgvector in `app_db`.
- [ ] Add Redis development service.
- [ ] Configure n8n against `n8n_db` only.
- [ ] Add development media-storage adapter/config.
- [ ] Add health checks.

### Database base
- [ ] Create migration system.
- [ ] Add UUID/ID strategy.
- [ ] Add timestamps/version conventions.
- [ ] Add tenant-scoped query conventions.
- [ ] Add outbox/event tables.
- [ ] Add audit infrastructure.

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
- [ ] Implement import/export jobs later in phase or subsequent release.
- [ ] Add indexes based on initial query patterns.
- [ ] Ensure no tenant-created physical DB tables/columns.

## Phase 5 — Media/object storage

- [ ] Document OpenMusk media service upload/read/delete/health APIs.
- [ ] Build storage adapter.
- [ ] Tenant/business namespacing.
- [ ] Authenticated uploads/deletes.
- [ ] MIME/content validation.
- [ ] File size/type limits.
- [ ] Content hash/dedup within allowed scope.
- [ ] Extract image/media metadata.
- [ ] Implement `media_assets`.
- [ ] Collection item media/gallery links.
- [ ] Media library UI.
- [ ] Reference-aware deletion/grace period.
- [ ] Backup/restore policy.
- [ ] Private vs provider-accessible media access strategy.

## Phase 6 — Redis, queue, workers

- [ ] Secure Redis configuration.
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
- [ ] Distributed locks.
- [ ] Queue administration in Super Admin.

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
- [ ] Persist final outbound message/delivery IDs.
- [ ] Channel reconnect behavior.
- [ ] Super Admin delivery diagnostics.

## Phase 9 — Media delivery optimization

- [ ] Implement `channel_media_cache`.
- [ ] Reuse Facebook attachment IDs when supported.
- [ ] Reuse WhatsApp/other remote media IDs according to provider rules.
- [ ] Detect stale/expired remote ID.
- [ ] Lock concurrent refresh/upload.
- [ ] Re-upload and update mapping.
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

- [ ] Inbound screenshot/image media ingestion.
- [ ] Vision model bounded batching.
- [ ] Structured observation output.
- [ ] Match/search attached business collections.
- [ ] Ensure live DB price/stock overrides vision assumptions.
- [ ] Multiple screenshot logical turn.
- [ ] Audio ingestion/transcription.
- [ ] Transcript provenance/status.
- [ ] Model limits/file limits/cost controls.

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
- [ ] Media cache/storage analytics.
- [ ] Business outcome analytics.
- [ ] Plan definitions/features.
- [ ] Hard/soft/budget/rate-limit engine.
- [ ] Effective-limit resolver.
- [ ] Redis fast counters + PostgreSQL reconciliation.
- [ ] Quota alerts.
- [ ] Super Admin usage/cost dashboards.

## Phase 18 — Billing readiness / optional payment integration

- [ ] Plans/prices/subscriptions data model.
- [ ] Plan assignment/change lifecycle.
- [ ] Trial/credit model if required.
- [ ] Usage billing record model.
- [ ] Payment provider integration when selected.
- [ ] Invoice/payment history UI.
- [ ] Overage policy.
- [ ] Platform-paid AI budget enforcement.

## Phase 19 — Super Admin completion

- [ ] Platform dashboard.
- [ ] Tenant/user support screens.
- [ ] Tenant suspension/reactivation.
- [ ] Plan/limit overrides.
- [ ] Channel health/reconnect diagnostics.
- [ ] Queue/job/dead-letter operations.
- [ ] n8n workflow health/version view.
- [ ] Redis/Postgres/media/worker health summaries.
- [ ] Feature flags.
- [ ] Audit/security console.
- [ ] Scoped impersonation/support view if approved.
- [ ] Dangerous-action re-authentication.

## Phase 20 — Security hardening

- [ ] Secret encryption/key rotation.
- [ ] Super Admin MFA.
- [ ] CSRF/security headers.
- [ ] SSRF protection for custom provider URLs.
- [ ] File upload hardening.
- [ ] Tenant RLS defense-in-depth where selected.
- [ ] API authorization penetration tests.
- [ ] Webhook signature tests.
- [ ] Rate-limit abuse tests.
- [ ] Audit coverage review.
- [ ] Privacy/retention implementation.
- [ ] Customer export/delete workflows.

## Phase 21 — Reliability/observability

- [ ] Structured logging.
- [ ] Correlation IDs end to end.
- [ ] API metrics.
- [ ] DB/Redis metrics.
- [ ] queue depth/age/throughput.
- [ ] worker heartbeat.
- [ ] n8n execution health.
- [ ] provider error dashboards.
- [ ] cost anomaly alerts.
- [ ] health/readiness endpoints.
- [ ] circuit/degraded behavior where appropriate.
- [ ] runbooks.

## Phase 22 — Backups and disaster recovery

- [ ] Automated app DB backups.
- [ ] n8n DB backups.
- [ ] Media backup/replication.
- [ ] Backup encryption/off-host copy.
- [ ] Restore test.
- [ ] Define RPO/RTO.
- [ ] Queue/Redis loss recovery procedure.
- [ ] Provider webhook reconciliation procedure.
- [ ] Disaster runbook exercise.

## Phase 23 — Legacy migration

- [ ] Inventory reusable n8n V4.2 behaviors.
- [ ] Rebuild spreadsheet-based config reads to SaaS API/DB reads.
- [ ] Remove Control Spreadsheet workflows.
- [ ] Remove Operations Spreadsheet workflows.
- [ ] Migrate Meta routing concepts.
- [ ] Migrate human handoff/echo protection.
- [ ] Migrate follow-up guards.
- [ ] Migrate image/screenshot logic.
- [ ] Migrate remote Facebook attachment cache logic into generic media layer.
- [ ] Migrate dynamic AI task routing.
- [ ] Validate legacy behavior with new regression suite.

## Phase 24 — Production launch

- [ ] Staging full end-to-end test.
- [ ] Load/burst tests.
- [ ] Tenant isolation/security signoff.
- [ ] Production secrets/configured domains.
- [ ] Meta production permissions/app review as required.
- [ ] Backups/alerts verified.
- [ ] Super Admin MFA enforced.
- [ ] Queue/dead-letter recovery verified.
- [ ] Customer onboarding tested from zero configuration.
- [ ] Operational runbook ready.
- [ ] Controlled pilot tenants.
- [ ] Monitor errors/costs/latency.
- [ ] General release after pilot criteria pass.

## Definition of done for any feature

A feature is not done until it has:

- tenant authorization
- validation
- idempotency where retryable
- audit coverage where sensitive
- usage/metrics where operationally relevant
- error/empty/loading states in UI
- tests at appropriate levels
- documentation updated
- migration/rollback considerations
- observability for production diagnosis