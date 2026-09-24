# n8n automation specification — implemented bundle 2.0.0

## 1. Role of n8n

n8n is the platform's automation/orchestration runtime. It coordinates turn processing, training synthesis, follow-up schedules, heartbeat/maintenance, and service-to-service workflow sequencing. It is not the SaaS database, authentication system, customer admin surface, AI-secret store, or authoritative business-rules engine.

The existing n8n runtime is operated outside this repository. This repository owns the sanitized workflow JSON artifacts under `automation/n8n/`, their manifest, deployment tooling, and the application contracts those workflows call.

## 2. Source-of-truth boundary

PostgreSQL `app_db` is the durable SaaS source of truth. n8n's own database stores n8n internal workflow/execution state only.

n8n must not mirror or directly own tenant business data. Authoritative state changes are performed by application APIs/workers with tenant authorization, validation, idempotency, audit, queueing, and transaction guarantees.

## 3. Raw Meta webhook boundary

Raw Facebook/Instagram/WhatsApp callbacks terminate at the SaaS API:

```text
Meta -> SaaS API /webhooks/meta
```

The API performs raw-body HMAC signature verification, webhook normalization, channel/tenant resolution, deduplication, persistence, delivery-status handling, media-ingestion queueing, and aggregation queueing.

This boundary is mandatory because provider signatures are calculated over the original body. n8n does not act as a transparent raw-body proxy for Meta.

After aggregation produces a logical conversation turn, the worker calls the n8n turn entrypoint.

## 4. Final workflow topology

```text
Meta callback
  -> API verify/normalize/dedupe/persist
  -> Redis/worker media + aggregation
  -> 01 Meta Turn Gateway
       -> 02 Inbound Conversation
            -> 04 Multimodal Preflight
            -> 03 Agent Runtime
                 -> internal orchestration API
                      -> AI/RAG/multimodal
                      -> business actions
                      -> handoff/follow-up policy
                      -> outbound queue
                      -> delivery worker

05 Training Pipeline
06 Follow-up Scheduler
07 Health and Maintenance
```

The split is modular at the orchestration boundary while expensive/stateful behavior remains in the backend/worker layer.

## 5. Workflow source files

The final bundle is:

```text
automation/n8n/
  manifest.json
  README.md
  workflows/
    01_meta_webhook_gateway.json
    02_inbound_conversation.json
    03_agent_runtime.json
    04_multimodal.json
    05_training_pipeline.json
    06_followups.json
    07_health_maintenance.json
```

`manifest.json` bundle version is `2.0.0` and API contract version is `1`.

## 6. Workflow responsibilities

### 01 Meta Turn Gateway

Public n8n entrypoint: `POST /webhook/saas-turn`.

Despite the filename retaining the original planned "Meta gateway" concept, this is **not** the raw Meta callback. It receives a verified/persisted/aggregated turn-ready event from the worker. It acknowledges quickly and forwards the event to the private inbound-conversation workflow.

This keeps provider ingress security in the API while preserving a stable n8n orchestration entrypoint for all Facebook, Instagram, and WhatsApp turns.

### 02 Inbound Conversation

Private n8n entrypoint: `POST /webhook/saas-inbound-conversation`.

It loads canonical runtime context through:

```text
GET /v1/internal/runtime/turn/:turnId
```

The API returns tenant/business/channel/conversation/turn context, messages, active agent/prompt references, collection schemas, recent history, and ready media. The workflow then runs multimodal preflight and agent runtime in sequence.

### 03 Agent Runtime

Private n8n entrypoint: `POST /webhook/saas-agent-runtime`.

It invokes:

```text
POST /v1/internal/orchestration/turn
```

The API remains responsible for HUMAN/AI eligibility, prompt/model routing, provider fallback, multimodal inference, current catalog/knowledge retrieval, action validation, handoff, outbound response planning, follow-up policy scheduling, and turn completion/failure state.

### 04 Multimodal Preflight

Private n8n entrypoint: `POST /webhook/saas-multimodal`.

It reloads the authoritative turn context and emits a compact media summary before agent runtime. It is deliberately a readiness/observability step rather than a credential-bearing AI pipeline.

Image/audio bytes are fetched server-side from Media Storage by the API, and task-specific vision/transcription models are resolved dynamically there. This prevents tenant secrets and business-state rules from being duplicated into n8n.

### 05 Training Pipeline

Public/application entrypoint: `POST /webhook/saas-training` with an existing `trainingJobId`.

It invokes `/v1/internal/training/synthesize` to produce a versioned prompt/agent candidate. Generated candidates require the configured application review/test/publish policy. The workflow does not silently replace an active production prompt.

### 06 Follow-up Scheduler

Schedule: every minute.

It invokes `/v1/internal/orchestration/followups/sweep` with a bounded batch limit. The API atomically claims due records and queues follow-up worker jobs. Final eligibility remains a worker/application concern so HUMAN mode, new customer replies, channel state, provider windows, quotas, idempotency, and rate limits are rechecked immediately before delivery.

### 07 Health and Maintenance

This workflow owns three operational paths:

- runtime heartbeat every minute -> `/v1/internal/n8n/heartbeat`;
- maintenance every fifteen minutes -> `/v1/internal/orchestration/maintenance`;
- public health endpoint -> `GET /webhook/saas-health`.

The heartbeat publishes the expected bundle/workflow manifest for Super Admin observability.

## 7. Runtime environment

n8n requires:

```text
SAAS_API_INTERNAL_URL
INTERNAL_SERVICE_AUTH_SECRET
N8N_INTERNAL_WEBHOOK_BASE_URL
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

`N8N_INTERNAL_WEBHOOK_BASE_URL` is the private base used for workflow-to-workflow calls. It should resolve over loopback/private container networking or another protected internal route and must not include a trailing slash.

The application/worker uses:

```text
N8N_TURN_WEBHOOK_URL=<public n8n>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=<public n8n>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=<public n8n>/webhook/saas-health
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

## 8. Public and private webhooks

Publicly reachable n8n paths:

```text
POST /webhook/saas-turn
POST /webhook/saas-training
GET  /webhook/saas-health
```

Internal-only paths:

```text
POST /webhook/saas-inbound-conversation
POST /webhook/saas-agent-runtime
POST /webhook/saas-multimodal
```

The reverse proxy/network policy should not intentionally expose internal paths to untrusted public callers. The raw Meta path is the API `/webhooks/meta`, not an n8n webhook.

## 9. AI and business-action boundary

Prompts define behavior; mutable business facts remain in PostgreSQL/knowledge retrieval. n8n does not hard-code provider/model/customer prompts.

The internal turn orchestrator follows this pattern:

```text
turn context
 -> HUMAN/AI eligibility
 -> active agent + prompt
 -> multimodal context
 -> current collection/RAG facts
 -> task model selection/fallback
 -> structured AI response
 -> validated business actions
 -> optional handoff
 -> outbound response plan
 -> queue
 -> rate-limited delivery worker
```

For an order/booking/lead/quote/support action, the AI proposes an action but the application service validates and commits it transactionally with an idempotency key.

## 10. Media rule

n8n passes identifiers/context and never relies on infrastructure filesystem paths. Media binaries live in the existing Media Storage service. The API/worker resolves tenant-scoped credentials, provider media cache IDs, binary fetch/re-upload, vision/transcription, and delivery state.

## 11. HUMAN mode

AI generation is blocked when the conversation is not AI-eligible. Manual Page-owner echoes and staff takeover are persisted by the API and can switch the conversation to HUMAN mode. Pending/outbound automation must respect the current conversation state/version before delivery.

## 12. Idempotency

Stable idempotency identifiers include provider message/event IDs, logical turn IDs, business-action keys, outbound logical response IDs, follow-up IDs, and training jobs. Workflow retries must route through the application contracts rather than create raw duplicate side effects.

## 13. Deployment artifacts and sanitation

Committed workflow JSON must be inactive and portable. It must contain no customer secrets, Meta tokens, AI keys, Media Storage admin credentials, production-only credential IDs, database/Redis connection strings, or fixed infrastructure hostnames.

The repository validator checks the manifest/file set and common forbidden-secret patterns.

## 14. Deployment process

Repository validation:

```bash
npm run validate:n8n
npm run n8n:plan
```

Staged create/update:

```bash
npm run n8n:deploy
```

Controlled activation after environment configuration/testing:

```bash
npm run n8n:deploy:activate
```

The deployment script matches workflows by their exact version-controlled names, refuses ambiguous duplicates, stages changes before activation, records deployment metadata when configured, and prevents unsafe in-place mutation of active canonical workflows.

## 15. Manual activation order

For manual imports, activate child dependencies before the public turn entrypoint:

```text
04 Multimodal Preflight
03 Agent Runtime
02 Inbound Conversation
01 Meta Turn Gateway
05 Training Pipeline
06 Follow-up Scheduler
07 Health and Maintenance
```

Then set application `N8N_*_WEBHOOK_URL` values and run the end-to-end checks.

## 16. Testing requirements

Before production cutover verify at minimum:

- Meta verification/signature rejection/acceptance on API `/webhooks/meta`.
- duplicate inbound event idempotency.
- text turn through 01 -> 02 -> 04 -> 03.
- multi-image/audio turn and media readiness.
- HUMAN-mode suppression.
- missing agent/prompt/model failure behavior.
- provider fallback behavior.
- order/booking/action idempotency.
- outbound queue/rate-limit behavior.
- follow-up guard/cancellation behavior.
- training candidate creation without unintended publish.
- health endpoint and fresh heartbeat.
- previous-bundle rollback.

## 17. Rollback

Deactivate workflow 01 first to stop new turn intake, then stop conflicting schedules and reactivate only a previous bundle compatible with the current API/database contract. Never leave two workflow bundles active for the same `saas-turn` webhook or follow-up schedule.

## 18. Operational guide

Exact per-workflow usage, environment wiring, smoke-test commands, troubleshooting, activation order, and rollback procedures are documented in:

- `automation/n8n/README.md`
- `docs/22_N8N_WORKFLOW_USAGE.md`

Those documents are the operator-facing instructions for bundle `2.0.0`.
