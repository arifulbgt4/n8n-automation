# Final n8n workflow usage guide

This guide describes how to operate workflow bundle `2.0.0` in the existing n8n runtime. The canonical JSON artifacts live in `automation/n8n/workflows/` and are deployed according to `automation/n8n/manifest.json`.

## 1. Runtime boundary

The final production path is intentionally split between the SaaS API/worker and n8n:

```text
Facebook / Instagram / WhatsApp
          |
          v
SaaS API /webhooks/meta
  raw signature verification
  normalization + dedupe + persistence
          |
          v
Redis queues / worker
  media ingestion + aggregation
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
              internal orchestration API
                     |
     +---------------+----------------+
     |               |                |
     v               v                v
 AI/RAG        business actions   outbound queue
                                      |
                                      v
                             provider delivery worker
```

Raw Meta callbacks never terminate at n8n. The SaaS API keeps the raw-body signature verification boundary because Meta HMAC validation must be performed against the original request body.

## 2. Workflow inventory

### `01_meta_webhook_gateway.json`

Public entrypoint: `POST /webhook/saas-turn`.

The aggregation worker calls this after it has produced a durable logical conversation turn. The workflow responds quickly and passes the turn-ready payload to workflow 02 through the private n8n webhook base.

Application setting:

```text
N8N_TURN_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-turn
```

### `02_inbound_conversation.json`

Private entrypoint: `POST /webhook/saas-inbound-conversation`.

It loads the authoritative runtime context from:

```text
GET /v1/internal/runtime/turn/:turnId
```

Then it runs workflow 04 followed by workflow 03. This workflow is the routing boundary between a verified/aggregated turn and the AI/business-action runtime.

### `03_agent_runtime.json`

Private entrypoint: `POST /webhook/saas-agent-runtime`.

It invokes:

```text
POST /v1/internal/orchestration/turn
```

The SaaS API performs AI eligibility checks, model/prompt routing, RAG/current-data lookup, multimodal inference, structured action execution, HUMAN handoff, response-plan creation, outbound enqueueing, and turn completion. n8n coordinates the operation without becoming the business-data source of truth.

### `04_multimodal.json`

Private entrypoint: `POST /webhook/saas-multimodal`.

It loads the turn context and reports message/media readiness before the agent runtime. Actual image/audio bytes and AI-provider calls stay in the API runtime, where tenant-scoped Media Storage credentials and AI keys are protected.

### `05_training_pipeline.json`

Public/application entrypoint: `POST /webhook/saas-training`.

Expected input:

```json
{
  "trainingJobId": "<uuid>"
}
```

It calls `/v1/internal/training/synthesize`. The result is a candidate prompt/agent version. Review, testing, publishing, rollback, and optional guarded auto-publish remain application responsibilities.

Application setting:

```text
N8N_TRAINING_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-training
```

### `06_followups.json`

Schedule: every minute.

It calls `/v1/internal/orchestration/followups/sweep` with a bounded batch limit. The API claims due follow-up rows and queues worker jobs. The delivery worker performs final eligibility, HUMAN-mode, policy-window, newer-message, idempotency, plan-limit, and rate-limit checks before send.

### `07_health_maintenance.json`

This workflow contains three paths:

- one-minute runtime heartbeat -> `/v1/internal/n8n/heartbeat`;
- fifteen-minute maintenance -> `/v1/internal/orchestration/maintenance`;
- public health endpoint -> `GET /webhook/saas-health`.

Application setting:

```text
N8N_HEALTH_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-health
```

## 3. n8n runtime environment

The n8n process requires:

```text
SAAS_API_INTERNAL_URL=<API URL reachable from n8n>
INTERNAL_SERVICE_AUTH_SECRET=<shared internal bearer secret>
N8N_INTERNAL_WEBHOOK_BASE_URL=<private n8n base URL with no trailing slash>
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

`N8N_INTERNAL_WEBHOOK_BASE_URL` is specifically for workflow-to-workflow calls. It should resolve over loopback, private container/service networking, or a protected internal proxy.

The following paths are internal and must not be intentionally exposed to untrusted public traffic:

```text
/webhook/saas-inbound-conversation
/webhook/saas-agent-runtime
/webhook/saas-multimodal
```

Only these n8n paths need public reachability:

```text
POST /webhook/saas-turn
POST /webhook/saas-training
GET  /webhook/saas-health
```

The Meta callback itself remains the SaaS API `/webhooks/meta` URL.

## 4. Application/worker environment

Configure:

```text
N8N_TURN_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-turn
N8N_TRAINING_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-training
N8N_HEALTH_WEBHOOK_URL=https://<public-n8n-host>/webhook/saas-health
N8N_WORKFLOW_BUNDLE_VERSION=2.0.0
```

The worker falls back to direct internal orchestration when the turn webhook is intentionally absent in development; production should use the n8n entrypoint when this bundle is the selected orchestration mode.

## 5. Automated deployment

Validate the committed bundle first:

```bash
npm run validate:n8n
npm run n8n:plan
```

For deployment, supply the n8n Public API management values:

```bash
export N8N_API_URL="https://<n8n-host>"
export N8N_API_KEY="<api-key>"
export SAAS_API_INTERNAL_URL="https://<api-host-reachable-from-deployer>"
export INTERNAL_SERVICE_AUTH_SECRET="<shared-secret>"
```

Stage workflows inactive:

```bash
npm run n8n:deploy
```

After the n8n process environment is configured and staging tests pass:

```bash
npm run n8n:deploy:activate
```

Do not keep an older workflow bundle active if it owns the same public webhook or schedule responsibility.

## 6. Manual import and activation

If the n8n API deployment script is not used:

1. Import all seven files from `automation/n8n/workflows/`.
2. Keep every imported workflow inactive while configuring the environment.
3. Verify n8n can reach `SAAS_API_INTERNAL_URL`.
4. Verify `N8N_INTERNAL_WEBHOOK_BASE_URL` resolves privately from the n8n process.
5. Activate workflow 04.
6. Activate workflow 03.
7. Activate workflow 02.
8. Activate workflow 01.
9. Activate workflow 05.
10. Activate workflow 06.
11. Activate workflow 07.
12. Set the application's three `N8N_*_WEBHOOK_URL` values.
13. Restart/reload services if environment variables are loaded only at process start.

The child-first order ensures the public turn gateway cannot receive traffic before its private downstream workflows exist and are active.

## 7. Required end-to-end checks

### Health

```bash
curl -fsS "https://<public-n8n-host>/webhook/saas-health"
```

Expected bundle: `2.0.0` and API contract `1`.

### Normal text turn

Use an existing staged `conversation_turns.id`:

```bash
curl -X POST "https://<public-n8n-host>/webhook/saas-turn" \
  -H 'content-type: application/json' \
  -d '{"turnId":"<existing-turn-uuid>"}'
```

Verify the workflow chain reaches workflow 03, the turn moves to processed/failed deterministically, and any outbound response enters the normal delivery queue.

### Multimodal turn

Send a real staged image or audio message through the configured Meta test channel. Verify media ingestion completes, workflow 04 reports media, workflow 03 processes the turn, and model usage is recorded.

### Business action

Exercise at least one enabled action such as order, booking, lead, quote, or support. Retry the same logical turn/action and verify the idempotency key prevents duplicate durable side effects.

### HUMAN mode

Put the conversation in HUMAN mode and verify workflow 03/API refuses AI response generation rather than sending an automated reply.

### Training

Use an existing training job and confirm a candidate is produced without automatically replacing the active prompt unless an explicitly approved auto-publish policy allows it.

### Follow-up

Create a due follow-up, confirm workflow 06 queues it, and verify a newer inbound customer message cancels/suppresses the pending follow-up.

## 8. Operational interpretation

n8n success only means orchestration steps completed. Provider delivery is asynchronous. A successful n8n execution can still be followed by a provider delivery failure, which must be inspected in message delivery state, worker logs, dead-letter queues, and analytics.

Conversely, a workflow 03 failure does not justify direct database edits. Fix the missing agent/model/channel/media configuration or retry the idempotent turn through the supported API/workflow path.

## 9. Troubleshooting map

| Symptom | Check first |
| --- | --- |
| `saas-turn` succeeds but no downstream execution | `N8N_INTERNAL_WEBHOOK_BASE_URL`, workflow 02 activation |
| workflow 02 cannot load turn | `SAAS_API_INTERNAL_URL`, internal secret, actual `turnId` |
| workflow 04 has zero media for an image turn | media-ingestion worker/status and Media Storage mapping |
| workflow 03 returns `CONVERSATION_NOT_AI_ELIGIBLE` | HUMAN/PAUSED/closed conversation state |
| workflow 03 returns agent/model config error | active agent, active prompt version, task model config |
| no outbound provider message | outbound queue, limiter, channel adapter, provider token/status |
| follow-up duplicates | duplicate active scheduler/bundle or idempotency/queue diagnosis |
| heartbeat stale | workflow 07 activation, API reachability, internal secret |
| health says wrong version | n8n `N8N_WORKFLOW_BUNDLE_VERSION` environment and process restart |

## 10. Rollback

Deactivate workflow 01 first to stop accepting new turn traffic. Then stop conflicting schedules, reactivate the previous API-compatible bundle, and verify a real staged turn, outbound delivery, heartbeat, and follow-up behavior. Never leave two bundles active for the same `saas-turn` webhook or follow-up schedule.

## 11. Source-of-record rule

Production editor changes are not canonical until exported, sanitized, reviewed, and committed. No committed workflow may contain customer tokens, AI keys, Meta credentials, Media Storage admin credentials, production-only credential IDs, or hard-coded infrastructure hostnames.
