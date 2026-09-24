# n8n workflow bundle

This directory is the source-of-record for the SaaS n8n automation bundle. Bundle `2.0.0` implements the final modular orchestration design while keeping durable business rules, credentials, tenant authorization, AI-provider access, database mutations, media access, and delivery guarantees in the SaaS API/worker layer.

## Security boundary

Meta must **not** post raw Facebook/Instagram/WhatsApp callbacks directly to n8n.

The provider callback remains:

```text
Meta -> SaaS API /webhooks/meta
     -> raw-body signature verification
     -> normalize/dedupe/persist
     -> media + aggregation queues
     -> turn-ready worker event
     -> n8n /webhook/saas-turn
```

This is intentional. Meta HMAC verification depends on the original raw request body. Re-serializing the payload through another proxy can invalidate the signature and weakens the trusted ingress boundary.

## Final workflow chain

```text
SaaS API /webhooks/meta
  -> Redis/worker aggregation
  -> 01 Meta Turn Gateway (saas-turn)
  -> 02 Inbound Conversation
       -> load authoritative turn context from SaaS API
       -> 04 Multimodal Preflight
       -> 03 Agent Runtime
            -> /v1/internal/orchestration/turn
            -> AI/RAG/multimodal analysis
            -> business actions
            -> outbound queue
            -> provider delivery workers

05 Training Pipeline             -> prompt/agent candidate synthesis
06 Follow-up Scheduler           -> due follow-up queueing
07 Health and Maintenance        -> heartbeat + maintenance + health endpoint
```

## Files

| File | Workflow | Trigger | Required | Purpose |
| --- | --- | --- | --- | --- |
| `01_meta_webhook_gateway.json` | SaaS - 01 Meta Turn Gateway | public webhook | yes | Receives a verified, aggregated `turnId` from the worker and routes it into the private conversation chain. |
| `02_inbound_conversation.json` | SaaS - 02 Inbound Conversation | private internal webhook | yes | Loads canonical turn/conversation/channel context, runs media preflight, then invokes the agent runtime. |
| `03_agent_runtime.json` | SaaS - 03 Agent Runtime | private internal webhook | yes | Calls the authoritative turn orchestrator that performs AI/RAG, actions, handoff, follow-up policy scheduling, and outbound enqueueing. |
| `04_multimodal.json` | SaaS - 04 Multimodal Preflight | private internal webhook | yes | Confirms media/context visibility before the agent runtime. Vision/transcription itself stays in the API where provider credentials and business facts are protected. |
| `05_training_pipeline.json` | SaaS - 05 Training Pipeline | public/application webhook | yes | Starts synthesis for an existing `trainingJobId`; candidate review/publish remains an application decision. |
| `06_followups.json` | SaaS - 06 Follow-up Scheduler | every minute | yes | Sweeps due follow-ups and queues them for guarded worker execution. |
| `07_health_maintenance.json` | SaaS - 07 Health and Maintenance | schedules + health webhook | yes | Publishes runtime heartbeat every minute, runs maintenance every 15 minutes, and exposes `saas-health`. |

## Required n8n runtime environment

Configure these values on the n8n runtime, not inside workflow JSON:

```text
SAAS_API_INTERNAL_URL=<private/reachable SaaS API base URL>
INTERNAL_SERVICE_AUTH_SECRET=<same secret used by the SaaS API>
N8N_INTERNAL_WEBHOOK_BASE_URL=<private n8n webhook base, no trailing slash>
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

`N8N_INTERNAL_WEBHOOK_BASE_URL` is used only for workflow-to-workflow calls. Prefer a loopback/private service address or an internal reverse-proxy route. Do not expose these internal webhook paths to the public internet:

```text
/webhook/saas-inbound-conversation
/webhook/saas-agent-runtime
/webhook/saas-multimodal
```

The externally reachable n8n webhook paths are:

```text
POST /webhook/saas-turn
POST /webhook/saas-training
GET  /webhook/saas-health
```

## Required application/worker environment

After the bundle is imported and activated, configure the SaaS application/worker:

```text
N8N_TURN_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=https://<n8n-public-host>/webhook/saas-health
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

Do not set `N8N_TURN_WEBHOOK_URL` to a Meta callback URL. Meta itself continues to call the SaaS API `/webhooks/meta` endpoint.

## How each workflow is used

### 01 Meta Turn Gateway

**Who calls it:** the aggregation worker through `N8N_TURN_WEBHOOK_URL`.

Expected body:

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

The gateway acknowledges quickly and forwards the body to the private `saas-inbound-conversation` webhook. It must receive only turn-ready events produced after provider verification, persistence, dedupe, aggregation, and media-ingestion coordination.

### 02 Inbound Conversation

**Who calls it:** workflow 01 through `N8N_INTERNAL_WEBHOOK_BASE_URL`.

The workflow calls:

```text
GET /v1/internal/runtime/turn/:turnId
```

This validates that the turn exists and resolves the canonical conversation, business, channel, active agent/prompt references, messages, schemas, and ready media from `app_db`. The workflow then calls workflow 04 and workflow 03 in sequence.

Do not bypass this workflow for normal production turns unless diagnosing the downstream agent runtime.

### 03 Agent Runtime

**Who calls it:** workflow 02.

It calls:

```text
POST /v1/internal/orchestration/turn
{
  "turnId": "<uuid>"
}
```

The API remains authoritative for:

- HUMAN/AI eligibility checks.
- active agent and prompt resolution.
- model selection and fallback.
- image analysis and audio transcription.
- collection lookup and pgvector/knowledge retrieval.
- structured AI response validation.
- order/booking/lead/quote/support actions.
- handoff.
- response-plan creation.
- outbound queueing.
- follow-up policy scheduling.
- completion/failure state.

This design deliberately avoids copying business rules or tenant secrets into n8n nodes.

### 04 Multimodal Preflight

**Who calls it:** workflow 02 before workflow 03.

It reloads the runtime turn and returns a compact summary containing `turnId`, message count, media count, and image/audio presence. It is a readiness/observability boundary, not the source of truth for AI media inference.

Actual media bytes are read through the server-side Media Storage adapter by the API runtime. Vision and transcription models are dynamically resolved per tenant/business/agent/channel in the API.

### 05 Training Pipeline

**Who calls it:** the application/worker when prompt synthesis is routed through n8n.

Expected body:

```json
{
  "trainingJobId": "<uuid>"
}
```

It calls:

```text
POST /v1/internal/training/synthesize
```

The result is a versioned prompt/agent candidate. The workflow does **not** silently publish over the active prompt. Review/test/publish and guarded auto-publish rules remain in the SaaS application.

### 06 Follow-up Scheduler

**Trigger:** once per minute.

It calls:

```text
POST /v1/internal/orchestration/followups/sweep
{
  "limit": 100
}
```

The API atomically claims due rows and queues `SEND_FOLLOWUP` jobs. The worker re-checks conversation/channel/tenant eligibility, customer replies, HUMAN mode, policy windows, idempotency, and rate limits before delivery.

Do not build a second follow-up scheduler outside this bundle unless the existing trigger is disabled, otherwise duplicate sweeps create unnecessary load.

### 07 Health and Maintenance

This workflow has three independent trigger paths.

**Runtime heartbeat — every minute**

Calls `/v1/internal/n8n/heartbeat` with bundle `2.0.0`, API contract `1`, runtime version, and the expected workflow manifest. Super Admin uses this to show deployment/runtime health.

**Maintenance — every 15 minutes**

Calls `/v1/internal/orchestration/maintenance`, which schedules application maintenance/analytics jobs through the normal queues.

**Health endpoint**

```text
GET /webhook/saas-health
```

Returns the current workflow bundle/API contract health descriptor. Use this for external reachability checks; use Super Admin heartbeat data for runtime freshness.

## Import and deployment

The repository includes `scripts/n8n-deploy.mjs` and `scripts/validate-n8n-bundle.mjs`.

Repository-only validation:

```bash
npm run validate:n8n
npm run n8n:plan
```

Deploy/update while inactive:

```bash
export N8N_API_URL="https://<n8n-host>"
export N8N_API_KEY="<n8n-public-api-key>"
export SAAS_API_INTERNAL_URL="https://<private-api-host>"
export INTERNAL_SERVICE_AUTH_SECRET="<shared-secret>"

npm run n8n:deploy
```

After environment configuration and staging tests, activate required workflows:

```bash
npm run n8n:deploy:activate
```

If an older SaaS workflow owns the same webhook path, review the conflict and use the deployer's controlled conflict-deactivation option rather than leaving both active.

## Recommended activation order for manual imports

If workflows are imported manually instead of with the deployment script:

1. Import all seven JSON files and keep them inactive.
2. Configure the n8n runtime environment values.
3. Verify `N8N_INTERNAL_WEBHOOK_BASE_URL` can reach the same n8n instance privately.
4. Activate `04 Multimodal Preflight`.
5. Activate `03 Agent Runtime`.
6. Activate `02 Inbound Conversation`.
7. Activate `01 Meta Turn Gateway`.
8. Activate `05 Training Pipeline`.
9. Activate `06 Follow-up Scheduler`.
10. Activate `07 Health and Maintenance`.
11. Configure the SaaS `N8N_*_WEBHOOK_URL` values.
12. Restart/reload API and worker processes if their environment loader requires it.
13. Verify health, heartbeat, one text turn, one multimodal turn, one business action, and one follow-up path.

The child-first order prevents the public `saas-turn` entrypoint from receiving traffic before its private downstream workflows are ready.

## Smoke tests

Health:

```bash
curl -fsS "https://<n8n-public-host>/webhook/saas-health"
```

Expected shape:

```json
{
  "status": "ok",
  "bundleVersion": "2.0.0",
  "apiContractVersion": "1"
}
```

Turn smoke test requires an existing real/staging `conversation_turns.id`:

```bash
curl -X POST "https://<n8n-public-host>/webhook/saas-turn" \
  -H 'content-type: application/json' \
  -d '{"turnId":"<existing-turn-uuid>"}'
```

Training smoke test requires an existing training job:

```bash
curl -X POST "https://<n8n-public-host>/webhook/saas-training" \
  -H 'content-type: application/json' \
  -d '{"trainingJobId":"<existing-training-job-uuid>"}'
```

Do not use random UUIDs and interpret `404 TURN_NOT_FOUND`/training lookup errors as workflow failure. Smoke tests should use staged records that exist in `app_db`.

## Production verification checklist

Before declaring the bundle live, verify:

- Meta GET verification and POST signature validation succeed on the SaaS API `/webhooks/meta` endpoint.
- `saas-turn` is reachable from the worker.
- the three internal webhook paths are reachable from n8n but blocked from untrusted public traffic.
- `SAAS_API_INTERNAL_URL` is reachable from n8n.
- the internal secret matches the API.
- `N8N_WORKFLOW_BUNDLE_VERSION=2.0.0` on both the application and n8n runtime.
- heartbeat appears in Super Admin.
- text-only conversation completes.
- image/audio turn completes.
- HUMAN mode suppresses AI.
- order/booking/lead action is idempotent.
- outbound messages enter the queue and respect rate limits.
- follow-up is cancelled when a newer customer message arrives.
- training creates a candidate without unexpectedly overwriting the active prompt.

## Failure diagnosis

### `saas-turn` returns but no AI reply appears

Check workflow 01 execution, then workflow 02, then 04/03. If workflow 03 reached the API, inspect the correlation/turn state and worker queues. Typical causes are missing active agent/prompt, missing model config, HUMAN mode, media still ingesting, or outbound queue/provider failure.

### Internal workflow call gives connection refused/404

`N8N_INTERNAL_WEBHOOK_BASE_URL` is wrong or its internal webhook routes are not activated. It must point to the webhook base, not `/api/v1`.

### API returns `401 INTERNAL_AUTH_REQUIRED`

`INTERNAL_SERVICE_AUTH_SECRET` differs between n8n and the SaaS API.

### Heartbeat is stale

Confirm workflow 07 is active and its one-minute schedule is executing. Then verify API connectivity and bundle version.

### Duplicate replies/follow-ups

Look for an older active bundle or duplicate schedule/webhook owner. Deactivate the conflicting workflow before retrying. Durable actions are idempotent, but duplicate active triggers still create load and confusing execution history.

## Rollback

For a production rollback:

1. Deactivate `01 Meta Turn Gateway` first so no new turns enter bundle 2.
2. Deactivate workflow 06 schedules and workflow 07 schedules/health as required.
3. Let already-queued worker jobs finish or drain them according to the operational runbook.
4. Reactivate the previous API-compatible bundle.
5. Point application `N8N_*_WEBHOOK_URL` values back only if webhook paths changed.
6. Verify Meta ingress, one conversation turn, outbound delivery, heartbeat, and follow-up processing.
7. Record the rollback reason in deployment metadata.

Never run two production bundles with the same public webhook/schedule responsibility at the same time.

## Ownership

Workflow JSON and `manifest.json` are the application-owned deployment source. Production editor changes are not canonical until exported, sanitized, reviewed, and committed back to this directory. Never commit customer credentials, Meta tokens, AI keys, n8n credential exports, or infrastructure-only secrets.
