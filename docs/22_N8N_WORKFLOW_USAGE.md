# Final n8n workflow usage guide

This is the operator guide for workflow bundle `2.0.0`. The canonical workflow JSON files are under `automation/n8n/workflows/`, and `automation/n8n/manifest.json` defines the required set.

## Runtime architecture

```text
Facebook / Instagram / WhatsApp
          |
          v
SaaS API /webhooks/meta
  raw-body HMAC verification
  normalize + dedupe + persist
          |
          v
Redis / worker aggregation
          |
          v
01 Meta Turn Gateway
          |
          v
02 Inbound Conversation
     |             |
     v             v
04 Multimodal   03 Agent Runtime
 Preflight           |
                     v
              SaaS internal orchestration
                     |
       AI/RAG + business actions
                     |
                     v
              outbound queue/worker
                     |
                     v
             provider API delivery
```

Raw Meta callbacks do not go to n8n. Provider verification remains on the SaaS API because Meta HMAC verification requires the original request body.

## Workflow inventory and usage

### 01 — `01_meta_webhook_gateway.json`

Entrypoint:

```text
POST /webhook/saas-turn
```

Caller: aggregation worker after a durable logical turn is ready.

Required header:

```text
Authorization: Bearer <INTERNAL_SERVICE_AUTH_SECRET>
```

Typical body:

```json
{
  "turnId": "<uuid>",
  "tenantId": "<uuid>",
  "businessId": "<uuid>",
  "channelAccountId": "<uuid>",
  "conversationId": "<uuid>",
  "correlationId": "<string>"
}
```

The workflow authenticates the caller and forwards the event to workflow 02 through the private n8n webhook base.

### 02 — `02_inbound_conversation.json`

Private entrypoint:

```text
POST /webhook/saas-inbound-conversation
```

It loads authoritative turn context from:

```text
GET /v1/internal/runtime/turn/:turnId
```

Then it runs workflow 04 and workflow 03. Normal production turns should enter through workflow 01 rather than calling this directly.

### 03 — `03_agent_runtime.json`

Private entrypoint:

```text
POST /webhook/saas-agent-runtime
```

It calls:

```text
POST /v1/internal/orchestration/turn
```

The SaaS API remains authoritative for AI eligibility, prompt/model routing, provider fallback, image/audio analysis, current catalog/RAG lookup, validated actions, HUMAN handoff, follow-up policy, outbound response planning, queueing, and turn completion.

### 04 — `04_multimodal.json`

Private entrypoint:

```text
POST /webhook/saas-multimodal
```

It reloads the turn and reports message/media readiness. Actual media bytes, tenant Media Storage credentials, vision/transcription models, and inference remain in the API layer.

### 05 — `05_training_pipeline.json`

Entrypoint:

```text
POST /webhook/saas-training
Authorization: Bearer <INTERNAL_SERVICE_AUTH_SECRET>
```

Body:

```json
{"trainingJobId":"<uuid>"}
```

It invokes `/v1/internal/training/synthesize`. The output is a versioned prompt/agent candidate. Review, test, publish, rollback, and any guarded auto-publish policy remain application-controlled.

### 06 — `06_followups.json`

Schedule: every minute.

It calls:

```text
POST /v1/internal/orchestration/followups/sweep
{"limit":100}
```

The API claims due jobs atomically. The worker re-checks HUMAN mode, tenant/channel state, newer inbound messages, provider windows, quotas, rate limits, and idempotency before delivery.

### 07 — `07_health_maintenance.json`

It contains three trigger paths:

```text
every 1 minute  -> /v1/internal/n8n/heartbeat
every 15 minutes -> /v1/internal/orchestration/maintenance
GET /webhook/saas-health -> workflow health response
```

The heartbeat reports bundle `2.0.0`, API contract `1`, runtime version, and the expected workflow manifest for Super Admin monitoring.

## n8n process environment

Configure on the existing n8n runtime:

```text
SAAS_API_INTERNAL_URL=<API base reachable from n8n>
INTERNAL_SERVICE_AUTH_SECRET=<shared internal secret>
N8N_INTERNAL_WEBHOOK_BASE_URL=<private n8n webhook base, no trailing slash>
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

`N8N_INTERNAL_WEBHOOK_BASE_URL` is used for n8n-to-n8n workflow calls. Prefer private container networking, loopback, or a protected internal reverse-proxy path.

Do not intentionally expose these internal webhooks to untrusted public traffic:

```text
/webhook/saas-inbound-conversation
/webhook/saas-agent-runtime
/webhook/saas-multimodal
```

Publicly reachable n8n endpoints are:

```text
POST /webhook/saas-turn       # bearer-authenticated
POST /webhook/saas-training   # bearer-authenticated
GET  /webhook/saas-health
```

The Meta callback is the SaaS API `/webhooks/meta` endpoint, not an n8n endpoint.

## Application/worker environment

Configure:

```text
N8N_TURN_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-health
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

The existing aggregation worker already sends the shared bearer header when it invokes `N8N_TURN_WEBHOOK_URL`. Any future training caller must do the same for `N8N_TRAINING_WEBHOOK_URL`.

## Automated deployment

Validate before touching n8n:

```bash
npm run validate:n8n
npm run n8n:plan
```

Configure deployment management credentials:

```bash
export N8N_API_URL="https://<n8n-host>"
export N8N_API_KEY="<n8n-api-key>"
export SAAS_API_INTERNAL_URL="https://<api-host>"
export INTERNAL_SERVICE_AUTH_SECRET="<shared-secret>"
```

Stage workflows inactive:

```bash
npm run n8n:deploy
```

After the n8n process environment and staging checks are complete:

```bash
npm run n8n:deploy:activate
```

Do not leave an older bundle active if it owns the same webhook or scheduler responsibility.

## Manual import

If importing through the n8n UI, import all seven JSON files while inactive. Configure the n8n environment, then activate in this dependency-safe order:

```text
04 Multimodal Preflight
03 Agent Runtime
02 Inbound Conversation
01 Meta Turn Gateway
05 Training Pipeline
06 Follow-up Scheduler
07 Health and Maintenance
```

After activation, configure the application `N8N_*_WEBHOOK_URL` values and restart/reload services if environment variables are read only at process start.

## Smoke tests

Health:

```bash
curl -fsS "https://<public-n8n-host>/webhook/saas-health"
```

Turn test using an existing staging `conversation_turns.id`:

```bash
curl -X POST "https://<public-n8n-host>/webhook/saas-turn" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"turnId":"<existing-turn-uuid>"}'
```

Training test using an existing training job:

```bash
curl -X POST "https://<public-n8n-host>/webhook/saas-training" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"trainingJobId":"<existing-training-job-uuid>"}'
```

Use real staging records, not random UUIDs.

## End-to-end acceptance checks

Before production cutover verify all of the following:

- Meta GET verification and POST signature validation succeed on API `/webhooks/meta`.
- Missing/wrong bearer token cannot reach workflow 01 or 05 downstream processing.
- a text-only turn traverses 01 -> 02 -> 04 -> 03.
- image/audio media is ingested before agent processing and multimodal inference succeeds.
- HUMAN/PAUSED/closed conversations do not receive AI replies.
- active agent, prompt, and model selection/fallback behave correctly.
- an order/booking/lead/quote/support action is idempotent on retry.
- outbound delivery enters the normal queue and obeys rate limits.
- a new customer message cancels/suppresses an obsolete follow-up.
- training generates a candidate without unintended active-prompt replacement.
- workflow 07 heartbeat is fresh in Super Admin.
- the health endpoint reports bundle `2.0.0`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Turn stops at unauthorized caller | Bearer header and shared secret parity between worker/app and n8n |
| Workflow 01 cannot reach workflow 02 | `N8N_INTERNAL_WEBHOOK_BASE_URL`, workflow 02 activation, internal routing |
| Workflow 02 cannot load turn | `SAAS_API_INTERNAL_URL`, internal secret, real `turnId` |
| Workflow 04 has no media | media-ingestion worker/status and Media Storage mapping |
| `CONVERSATION_NOT_AI_ELIGIBLE` | HUMAN/PAUSED/closed conversation state |
| Agent/model configuration error | active agent, active prompt, task model config |
| Orchestration succeeds but no customer message | outbound queue, rate limiter, adapter/provider status, dead-letter jobs |
| Follow-up duplicates | duplicate active bundle/scheduler and idempotency state |
| Heartbeat stale | workflow 07 activation, API reachability, shared secret |
| Wrong health bundle version | n8n `N8N_WORKFLOW_BUNDLE_VERSION` and process restart |

## Rollback

Deactivate workflow 01 first to stop new turn intake. Then disable conflicting scheduled workflows, drain or safely handle already queued jobs, reactivate only a previous bundle compatible with the current API/database contract, and verify a real turn, outbound delivery, follow-up path, and heartbeat. Never keep two production bundles active for the same `saas-turn` webhook or follow-up schedule.

## Source-of-record rule

Production editor changes are not canonical until exported, sanitized, reviewed, and committed. Workflow JSON must never contain customer tokens, AI keys, Meta credentials, Media Storage admin secrets, n8n credential exports, production-only credential IDs, or hard-coded infrastructure hostnames.
