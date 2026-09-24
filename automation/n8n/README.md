# Final n8n workflow bundle

Bundle `2.0.0` is the version-controlled source-of-record for the SaaS automation running on the existing n8n instance. Business data, tenant authorization, provider credentials, AI/model resolution, durable actions, media access, queues, and delivery guarantees remain in the SaaS API/worker layer; n8n coordinates the workflows.

## Security boundary

Raw Facebook, Instagram, and WhatsApp callbacks must go to the SaaS API:

```text
Meta -> SaaS API /webhooks/meta
     -> raw-body HMAC verification
     -> normalize + dedupe + persist
     -> media/aggregation workers
     -> turn-ready event
     -> n8n /webhook/saas-turn
```

Do not configure Meta to call n8n directly. Meta signature verification depends on the original raw request body.

The public `saas-turn` and `saas-training` n8n webhooks also require:

```http
Authorization: Bearer <INTERNAL_SERVICE_AUTH_SECRET>
```

The worker already sends this header for `saas-turn`. Any application code that invokes `saas-training` must send the same header.

## Final workflow chain

```text
01 Meta Turn Gateway
  -> 02 Inbound Conversation
       -> 04 Multimodal Preflight
       -> 03 Agent Runtime
            -> /v1/internal/orchestration/turn
            -> AI/RAG/multimodal + business actions
            -> outbound queue -> delivery worker

05 Training Pipeline
06 Follow-up Scheduler
07 Health and Maintenance
```

## Workflow files

| File | Trigger | Use |
| --- | --- | --- |
| `01_meta_webhook_gateway.json` | `POST /webhook/saas-turn` | Authenticated turn-ready entrypoint from the aggregation worker. |
| `02_inbound_conversation.json` | private `POST /webhook/saas-inbound-conversation` | Loads authoritative turn context, then runs multimodal preflight and agent runtime. |
| `03_agent_runtime.json` | private `POST /webhook/saas-agent-runtime` | Calls the authoritative turn orchestration API. |
| `04_multimodal.json` | private `POST /webhook/saas-multimodal` | Confirms message/media readiness before agent runtime. |
| `05_training_pipeline.json` | authenticated `POST /webhook/saas-training` | Runs prompt/agent candidate synthesis for a `trainingJobId`. |
| `06_followups.json` | every minute | Sweeps due follow-ups into the guarded worker queue. |
| `07_health_maintenance.json` | schedules + `GET /webhook/saas-health` | Heartbeat, maintenance, and health endpoint. |

## n8n runtime environment

Configure these on the n8n process:

```text
SAAS_API_INTERNAL_URL=<private/reachable SaaS API base>
INTERNAL_SERVICE_AUTH_SECRET=<same shared secret used by API/worker>
N8N_INTERNAL_WEBHOOK_BASE_URL=<private n8n webhook base, no trailing slash>
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

`N8N_INTERNAL_WEBHOOK_BASE_URL` is only for workflow-to-workflow calls. Prefer loopback/private service networking. These paths are internal and should be blocked from untrusted public traffic:

```text
/webhook/saas-inbound-conversation
/webhook/saas-agent-runtime
/webhook/saas-multimodal
```

Publicly reachable n8n paths are:

```text
POST /webhook/saas-turn       # bearer-authenticated
POST /webhook/saas-training   # bearer-authenticated
GET  /webhook/saas-health
```

## Application/worker environment

After import and activation, configure:

```text
N8N_TURN_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-health
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

Meta itself continues to use the SaaS API `/webhooks/meta` URL.

## Workflow usage

### 01 Meta Turn Gateway

The aggregation worker calls `N8N_TURN_WEBHOOK_URL` after a logical turn has been persisted and made ready.

Expected request:

```http
POST /webhook/saas-turn
Authorization: Bearer <INTERNAL_SERVICE_AUTH_SECRET>
Content-Type: application/json
```

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

The workflow authenticates the caller and routes the event to workflow 02.

### 02 Inbound Conversation

Workflow 01 calls this through the private n8n base. It loads:

```text
GET /v1/internal/runtime/turn/:turnId
```

The returned data includes the canonical conversation/turn, tenant/business/channel references, active agent/prompt, messages, recent history, collection schemas, and ready media. It then runs workflow 04 followed by workflow 03.

### 03 Agent Runtime

Workflow 02 calls this internally. It invokes:

```text
POST /v1/internal/orchestration/turn
{"turnId":"<uuid>"}
```

The API handles AI eligibility, model/prompt selection, provider fallback, current catalog and pgvector/RAG retrieval, image/audio analysis, validated business actions, HUMAN handoff, response-plan creation, follow-up policy scheduling, outbound enqueueing, and turn completion/failure state.

### 04 Multimodal Preflight

Workflow 02 calls this before workflow 03. It reloads runtime context and returns a compact summary of message/media readiness. Actual image/audio bytes and AI provider credentials remain server-side in the API/Media Storage integration.

### 05 Training Pipeline

Call it with an existing training job:

```http
POST /webhook/saas-training
Authorization: Bearer <INTERNAL_SERVICE_AUTH_SECRET>
Content-Type: application/json
```

```json
{"trainingJobId":"<uuid>"}
```

It invokes `/v1/internal/training/synthesize`. The result is a versioned candidate; review/test/publish remains an application decision unless an explicitly approved auto-publish policy applies.

### 06 Follow-up Scheduler

Every minute it calls:

```text
POST /v1/internal/orchestration/followups/sweep
{"limit":100}
```

The API atomically claims due jobs. The worker re-checks channel/tenant state, HUMAN mode, newer customer replies, policy windows, quotas, idempotency, and rate limits immediately before delivery.

### 07 Health and Maintenance

Three independent paths exist:

- every minute -> `/v1/internal/n8n/heartbeat`;
- every 15 minutes -> `/v1/internal/orchestration/maintenance`;
- health -> `GET /webhook/saas-health`.

The heartbeat publishes bundle `2.0.0` plus the expected workflow manifest so Super Admin can detect stale/missing deployments.

## Validation and deployment

Validate locally/repository-only:

```bash
npm run validate:n8n
npm run n8n:plan
```

Stage on an authorized n8n instance:

```bash
export N8N_API_URL="https://<n8n-host>"
export N8N_API_KEY="<n8n-public-api-key>"
export SAAS_API_INTERNAL_URL="https://<private-api-host>"
export INTERNAL_SERVICE_AUTH_SECRET="<shared-secret>"

npm run n8n:deploy
```

After the n8n runtime environment is configured and staging tests pass:

```bash
npm run n8n:deploy:activate
```

The deployer refuses ambiguous workflow-name matches and unsafe in-place mutation of an active canonical workflow. Activation remains an explicit phase.

## Manual import activation order

If importing JSON files through the n8n UI, import all seven inactive and activate child dependencies first:

```text
04 Multimodal Preflight
03 Agent Runtime
02 Inbound Conversation
01 Meta Turn Gateway
05 Training Pipeline
06 Follow-up Scheduler
07 Health and Maintenance
```

Then configure the application's `N8N_*_WEBHOOK_URL` values and restart/reload API/worker processes if their environment is read only at startup.

## Smoke tests

Health:

```bash
curl -fsS "https://<n8n-public-host>/webhook/saas-health"
```

Expected bundle/API contract:

```json
{"status":"ok","bundleVersion":"2.0.0","apiContractVersion":"1"}
```

Turn test using an existing staging turn:

```bash
curl -X POST "https://<n8n-public-host>/webhook/saas-turn" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"turnId":"<existing-turn-uuid>"}'
```

Training test using an existing training job:

```bash
curl -X POST "https://<n8n-public-host>/webhook/saas-training" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_AUTH_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"trainingJobId":"<existing-training-job-uuid>"}'
```

Random UUIDs are not valid smoke-test fixtures; use records that exist in staging `app_db`.

## Production verification

Before cutover, verify Meta GET verification and POST signature handling on API `/webhooks/meta`, authenticated `saas-turn`, private internal n8n routes, API reachability, shared-secret parity, bundle version `2.0.0`, fresh heartbeat, text turn, image/audio turn, HUMAN-mode suppression, idempotent business action, outbound queue/rate limits, follow-up cancellation after a new customer message, and training candidate generation without unintended publish.

## Troubleshooting

- `saas-turn` execution stops at **Reject Unauthorized Caller**: worker/app secret does not match n8n `INTERNAL_SERVICE_AUTH_SECRET`, or caller omitted the bearer header.
- gateway executes but workflow 02 is missing: check `N8N_INTERNAL_WEBHOOK_BASE_URL` and workflow 02 activation.
- workflow 02 cannot load the turn: verify `SAAS_API_INTERNAL_URL`, internal secret, and a real `turnId`.
- workflow 04 reports no media: inspect media-ingestion worker status and Media Storage mapping.
- workflow 03 returns `CONVERSATION_NOT_AI_ELIGIBLE`: inspect HUMAN/PAUSED/closed state.
- no provider reply after successful orchestration: inspect outbound queue, limiter, channel adapter, provider token/status, and dead-letter jobs.
- heartbeat is stale: verify workflow 07 schedules and API reachability.
- duplicate replies/follow-ups: find and deactivate an older active workflow bundle/scheduler.

## Rollback

Deactivate workflow 01 first so no new turns enter bundle 2. Then stop conflicting schedules, drain or safely handle already queued jobs, and reactivate only a previous bundle compatible with the current API/database contract. Never leave two production bundles active for the same `saas-turn` webhook or follow-up responsibility.

## More documentation

The canonical architecture is in `docs/08_N8N_AUTOMATION.md`. Detailed operator guidance is in `docs/22_N8N_WORKFLOW_USAGE.md`.

Never commit customer secrets, Meta tokens, AI keys, n8n credential exports, production-only credential IDs, or infrastructure-only credentials into workflow JSON.
