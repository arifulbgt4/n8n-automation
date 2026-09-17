# n8n automation specification

## 1. Role of n8n

n8n is the platform's **automation and integration orchestrator**. It coordinates provider webhooks, AI calls, scheduled flows, follow-ups, and external integrations, but it is not the SaaS database, authentication system, customer admin surface, or primary source of business truth.

The n8n runtime is already provisioned and operated outside this application repository. This repository does **not** install, configure, or replace n8n infrastructure. It owns the SaaS-specific n8n workflow JSON artifacts and the contracts those workflows use.

## 2. Database rule

n8n's own database stores only n8n internal data. SaaS business data remains in `app_db`.

There is no `n8n_db <-> app_db` synchronization process.

n8n obtains business state through:

1. preferred internal SaaS API/service calls for mutations and policy-sensitive reads.
2. explicitly approved read-only PostgreSQL queries for selected internal/high-throughput cases.
3. queue/event payloads carrying identifiers and bounded immutable facts.

n8n should not directly write raw business tables except where a reviewed contract explicitly permits it.

## 3. Recommended workflow decomposition

Avoid a giant monolithic workflow. Use small, versioned workflows with clear ownership and shared sub-workflows/services.

### A. Meta Webhook Gateway

- Facebook/Instagram/WhatsApp webhook verification endpoints where required.
- POST event intake or handoff from backend gateway.
- signature/verification checks at the selected boundary.
- normalization handoff.
- fast dedupe/persist/enqueue.

Heavy AI/media work must not block webhook acknowledgment.

### B. Inbound Conversation Orchestrator

- resolve tenant/business/channel/conversation context.
- check tenant/channel state.
- trainer identity vs production route.
- HUMAN/AI mode.
- aggregation/turn-ready coordination.
- route to relevant agent runtime.

### C. Agent Runtime Orchestrator

- load active agent/version/provider configuration.
- classify/route intent when needed.
- request structured/vector context.
- invoke configured AI task.
- validate structured AI output.
- call application action endpoints for order/booking/lead/etc.
- build provider-neutral response plan.
- enqueue outbound delivery.

### D. Multimodal / Vision / Audio

- process bounded image/screenshot batches.
- call configured vision model.
- produce structured search hints.
- route to current business data.
- process supported audio/transcription.
- persist transcript/analysis provenance through application services.

Never treat image-derived price/stock/availability as authoritative when current database data exists.

### E. Training Pipeline

- receive trainer/session event.
- gather approved training context.
- invoke prompt-synthesis model.
- return/store candidate through application service.
- record usage/status.

Publishing remains a customer/application decision unless an explicit auto-publish policy is enabled.

### F. Follow-up Scheduler/Executor

- identify/receive due follow-up jobs.
- re-check eligibility immediately before send.
- block HUMAN/inactive/disconnected/limit/policy violations.
- enqueue outbound delivery; never bypass queue/rate limiter.

### G. Health / Maintenance

- channel connection health checks.
- AI provider connectivity checks where safe.
- cache/config invalidation signals.
- workflow heartbeat/version reporting.

Use workers/services instead of n8n schedules where that is safer for platform housekeeping.

## 4. Shared contracts

Centralize reusable operations:

- resolve channel/tenant/business.
- resolve active agent/prompt/model configuration.
- record usage.
- emit application event.
- create outbound response plan.
- normalize errors.

If shared behavior is safer in backend/worker code, call that service rather than duplicating logic in several n8n workflows.

## 5. Webhook processing timing

```text
Receive -> verify -> dedupe/persist/enqueue -> 2xx
```

Do not hold provider requests open during model inference, multi-image analysis, media upload, multi-message send, vector-heavy processing, or order confirmation orchestration.

## 6. Credentials

Customer BYOK credentials are not manually configured as one n8n credential per customer.

Preferred approach:

- tenant secrets live encrypted in application secret storage/database.
- internal services resolve/decrypt them only for approved runtime operations.
- workflows receive task-scoped results/credentials only through approved interfaces.
- n8n execution logs must not contain keys.

Platform-level credentials may use n8n credential storage where appropriate. Media Storage admin credentials are never used by workflows. Direct media access, if approved, uses only a tenant/platform media user credential or goes through the SaaS internal media API.

## 7. Dynamic model routing

Task-specific model configs are stored in `app_db`. n8n resolves provider/model dynamically for tasks such as:

- default chat.
- intent classification.
- image analysis.
- transcription.
- structured extraction.
- prompt synthesis.
- embeddings.

No workflow hard-codes one provider/model as the only option.

## 8. Dynamic prompts

Prompts come from the active agent/prompt version resolved at runtime. n8n does not contain hidden business-specific fallback prompts.

If required configuration is missing, return a clear configuration error and safe customer response/escalation rather than silently using unrelated defaults.

## 9. Business actions

n8n orchestrates; the application service performs authoritative validation/mutation.

```text
AI proposes create_order
 -> n8n calls internal order API with idempotency key
 -> application validates tenant/business/items/stock/required fields
 -> DB transaction commits
 -> application returns result
 -> n8n builds confirmation response plan
 -> outbound queue delivers
```

Use the same pattern for bookings, leads, quotes, support cases, etc.

## 10. Outbound delivery

n8n should not synchronously loop through many messages/images in the main conversation workflow.

```text
Response plan
 -> enqueue outbound jobs
 -> delivery worker
 -> Redis rate limiter
 -> media resolver/channel adapter
 -> provider API
```

n8n may receive delivery-result events when later orchestration depends on them.

## 11. Media use

n8n references internal `media_asset_id`. The media/delivery layer determines whether the actual send uses:

- reusable provider media ID.
- authenticated binary content fetched from Media Storage.
- approved public media URL.
- fresh provider upload.

Workflows must not know host filesystem paths or infrastructure admin URLs.

## 12. HUMAN mode

Before producing or dispatching an automated reply, re-check conversation mode late enough to avoid a race with human takeover.

Where feasible:

- acquire/consult conversation lock/version.
- generate response.
- verify mode/version again before enqueue/send.
- suppress pending AI jobs after HUMAN takeover.

## 13. Manual Page-owner echo detection

Compare provider echo events against durable outbound message/provider IDs so bot/API echoes are ignored while a genuine manual Page-owner response may switch the conversation to HUMAN mode under customer policy.

## 14. Follow-up guards

Immediately before follow-up send verify:

- channel active/connected.
- tenant not suspended.
- conversation AI-eligible.
- not HUMAN mode.
- no newer customer response invalidating the job.
- provider messaging window/policy allows send.
- plan/rate limits allow send.
- idempotency key not already completed.

## 15. Error handling

Classify errors:

- configuration missing/invalid.
- authentication/reconnect required.
- tenant suspended/limit reached.
- provider transient/permanent.
- AI validation/format failure.
- application action rejected.
- media unavailable/quota/file missing.
- queue unavailable.

Emit structured operational events with correlation IDs.

## 16. Idempotency

Stable identifiers include:

- inbound provider event/message ID.
- logical turn ID.
- order/action idempotency key.
- outbound delivery idempotency key.
- follow-up unique key.
- training job ID.

Retries must not duplicate durable side effects.

## 17. Workflow JSON artifacts

The workflow source-of-record for deployment is version-controlled JSON in this repository, not an undocumented production-only n8n editor state.

Planned layout:

```text
automation/
  n8n/
    manifest.json
    workflows/
      01_meta_webhook_gateway.json
      02_inbound_conversation.json
      03_agent_runtime.json
      04_multimodal.json
      05_training_pipeline.json
      06_followups.json
      07_health_maintenance.json
    README.md
```

This directory is created during implementation when the first workflows are ready. Documentation-only planning does not require adding placeholder JSON files now.

## 18. Workflow bundle manifest

A manifest records the bundle version and required workflow set.

Conceptual format:

```json
{
  "bundleVersion": "1.0.0",
  "minimumN8nVersion": "validated-version-or-range",
  "apiContractVersion": "1",
  "workflows": [
    {
      "key": "meta-webhook-gateway",
      "file": "workflows/01_meta_webhook_gateway.json",
      "required": true,
      "activation": "webhook"
    }
  ]
}
```

The manifest may also track required environment keys, credential aliases, migration notes, and checksums.

## 19. Export sanitation

Every committed workflow export must be reviewed for portability/security:

- no Meta access token/API key/customer secret.
- no Media Storage admin token.
- no production-only hostname if configuration can be injected.
- no customer data/sample secrets.
- no unnecessary environment-specific credential ID dependency.
- stable meaningful workflow/node names.
- valid JSON.
- version/manifest updated.
- documentation/API contracts updated when behavior changes.

Never commit n8n credential exports or n8n database data.

## 20. Initial import process

The n8n runtime already exists. Initial deployment is an import/configure/test/activate operation:

1. export and commit sanitized workflow JSON from the validated development/staging workflow.
2. review the Git diff and manifest version.
3. open the target n8n runtime.
4. import each workflow JSON using the n8n workflow import-from-file capability.
5. keep imported workflows inactive.
6. bind environment-specific platform/internal credentials.
7. verify internal API/Redis/media dependencies.
8. ensure webhook paths/schedules do not conflict with currently active workflows.
9. execute manual/test paths and end-to-end checks.
10. record target n8n workflow IDs + bundle version in deployment metadata.
11. perform controlled activation/cutover.

Do not activate duplicate webhook or schedule workflows while the previous bundle is still active.

## 21. Update/cutover strategies

### Blue/green bundle — preferred for major changes

```text
bundle A active
 -> import bundle B inactive
 -> configure/test B
 -> deactivate conflicting triggers in A
 -> activate B
 -> monitor
 -> retain A for bounded rollback window
```

### In-place update

Allowed only when deployment tooling can deterministically target the existing workflow and a backup/export of the current version exists.

Human-readable workflow names are not sufficient deployment identity by themselves.

## 22. Automated deployment later

After manual import/cutover is stable, implement deployment automation using the API/CLI supported by the exact deployed n8n version.

The deployer should:

- read manifest.
- validate n8n compatibility.
- validate required configuration/credential aliases.
- create/update workflows deterministically.
- keep trigger activation explicit.
- record workflow IDs/bundle version/timestamp/result.
- support dry-run/diff where possible.
- avoid partial activation of conflicting webhook versions.

Do not hard-code an n8n management API route before implementation confirms the installed n8n version/interface.

## 23. Workflow versioning and visibility

Track expected/deployed workflow bundle version in platform deployment metadata. Super Admin should eventually show:

- expected bundle version.
- deployed bundle version.
- required workflows present/missing.
- workflow active/inactive state.
- last heartbeat/health.
- recent execution failures.
- deployment timestamp.

Changing workflow contracts requires compatible API/event changes and migration notes.

## 24. Rollback

Rollback sequence:

1. deactivate new conflicting triggers.
2. restore/reactivate previous compatible bundle.
3. verify application API/database compatibility.
4. verify provider webhook health.
5. record rollback reason/state.

Do not roll back to a workflow bundle that cannot understand the current API/database contract.

## 25. Environment separation

Development/staging/production must use isolated data/credentials/workflow deployment state. Never test production provider callbacks with development secrets/workflows.

Infrastructure endpoints come from deployment configuration, not committed JSON.

## 26. Testing strategy

Workflow tests cover:

- multi-business routing.
- Facebook/Instagram/WhatsApp routing.
- trainer identity routing.
- HUMAN mode.
- duplicate webhook.
- screenshot/multi-image turn.
- missing prompt/model config.
- provider failure/fallback policy.
- order/booking idempotency.
- follow-up guards.
- media-cache stale-ID fallback.
- Media Storage binary retrieval/quota/unavailable cases.
- queue failure/recovery.
- import of a fresh sanitized workflow bundle.
- prevention of duplicate active webhook/schedule bundles.

## 27. Acceptance criteria

n8n architecture is complete when:

- all business state can be managed from SaaS applications without editing workflow data manually.
- the same workflow bundle safely serves many tenants/businesses/channels dynamically.
- n8n infrastructure installation is not duplicated in this repository.
- Git contains sanitized reproducible workflow JSON + manifest.
- imported workflows can be configured/tested while inactive.
- bundle activation/rollback is controlled and observable.
- customer/Media/AI secrets are absent from committed workflow JSON.