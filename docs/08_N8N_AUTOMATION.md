# n8n automation specification

## 1. Role of n8n

n8n is the platform's **automation and integration orchestrator**. It coordinates provider webhooks, AI calls, scheduled flows, follow-ups, and external integrations, but it is not the SaaS database, authentication system, customer admin surface, or primary source of business truth.

The previous `n8n_local_envirnment` project remains a behavioral reference. Its spreadsheet control plane is replaced by the web application and `app_db`.

## 2. Database rule

n8n's own database stores only n8n internal data. SaaS business data remains in `app_db`.

There is no `n8n_db <-> app_db` synchronization process.

n8n obtains business state through:

1. Preferred internal SaaS API/service calls for mutations and policy-sensitive reads.
2. Explicitly approved direct read-only PostgreSQL queries for high-throughput/internal operations.
3. Queue/event payloads that contain identifiers and bounded immutable facts.

n8n should not directly write raw business tables except where a reviewed contract explicitly permits it.

## 3. Recommended workflow decomposition

Avoid a new 170+ node monolith. Use small, versioned workflows with clear ownership and shared sub-workflows/services.

Proposed workflow families:

### A. Meta Webhook Gateway

Responsibilities:

- Facebook/Instagram/WhatsApp webhook verification endpoints as required.
- POST event intake or handoff from the backend gateway.
- Basic signature/verification checks where placed in n8n.
- Normalize provider metadata or call normalization service.
- Fast dedupe/receipt handoff.
- Enqueue processing.

Heavy AI/media work must not block the webhook acknowledgment.

### B. Inbound Conversation Orchestrator

Responsibilities:

- Resolve normalized tenant/business/channel/conversation context.
- Check tenant/channel active state.
- Check trainer identity vs production path.
- Check HUMAN/AI mode.
- Coordinate aggregation/turn-ready event.
- Route to relevant agent workflow.

### C. Agent Runtime Orchestrator

Responsibilities:

- Load agent/version/provider configuration.
- Classify/route intent if needed.
- Request structured/vector context.
- Invoke configured AI task.
- Validate structured AI output.
- Call application action endpoints for order/booking/lead/etc.
- Build provider-neutral response plan.
- Enqueue outbound delivery.

### D. Vision / Screenshot Analysis

Responsibilities:

- Process turn media under bounded limits.
- Call configured vision task model.
- Produce structured search hints/observations.
- Feed catalog/data retrieval path.

Never treat vision-derived price/stock as authoritative if current database data exists.

### E. Audio / Transcription

Responsibilities:

- Validate supported media type/size.
- Use configured transcription model/provider.
- Persist normalized transcript with provenance.
- Continue through normal conversation runtime.

### F. Training Pipeline

Responsibilities:

- Receive trainer example/session event.
- Gather approved training context through API.
- Invoke prompt-synthesis model.
- Return/store candidate through application service.
- Record usage/status.

Publishing remains an application/customer decision unless approved auto-publish policy applies.

### G. Follow-up Scheduler/Executor

Responsibilities:

- Identify or receive due follow-up jobs.
- Re-check eligibility immediately before send.
- Block HUMAN mode/inactive/disconnected/limit violations.
- Enqueue outbound message; do not bypass delivery queue.

### H. Scheduled Maintenance / Health

Examples:

- Channel connection health checks.
- AI provider connectivity checks where safe.
- Stale configuration/cache invalidation signals.
- n8n workflow heartbeat/version reporting.

Avoid using n8n schedules for every recurring platform housekeeping task if a worker/service is more appropriate.

## 4. Shared sub-workflows/contracts

Reusable logical operations should be centralized to prevent divergence:

- Resolve channel/tenant/business.
- Resolve agent configuration.
- Resolve AI model task config.
- Record usage.
- Emit application event.
- Create outbound response plan.
- Error normalization.

If shared behavior is easier and safer in the backend/worker code, prefer calling that service rather than duplicating it in multiple n8n workflows.

## 5. Webhook processing timing

Provider webhook acknowledgment should be fast:

```text
Receive -> verify -> dedupe/persist/enqueue -> 2xx
```

Then asynchronous processing continues.

Do not hold the provider request open during:

- model inference
- vector search beyond minimal required ingest
- image downloads/uploads
- multi-message sends
- order confirmation workflows

## 6. n8n credentials

n8n may still need credentials for provider/integration calls, but customer BYOK credentials should not be manually configured as one n8n credential per customer.

Preferred approach:

- Tenant secrets live encrypted in application secret storage/database.
- A controlled internal service resolves/decrypts them for runtime use, or n8n receives short-lived/secure task-scoped credentials through an approved interface.
- n8n execution logs must not contain keys.

Platform-level credentials used only by operators can use n8n credential storage when appropriate.

## 7. Dynamic provider/model routing

Legacy behavior supported account-specific task keys such as intent classification, image analysis, transcription, product search response, order extraction, and general answer. Target SaaS generalizes this into task-specific model configs stored in `app_db`.

n8n resolves the task configuration dynamically. No workflow should hard-code a single OpenAI/Gemini/Anthropic model as the only option.

## 8. Dynamic prompts

Prompts come from the active agent/prompt version resolved at runtime. n8n does not contain a business-specific fallback prompt hidden inside nodes.

If required configuration is missing, the flow should produce a clear configuration error and safe customer response/escalation rather than silently using unrelated defaults.

## 9. Business actions

n8n may orchestrate actions but the application service performs authoritative validation/mutation.

Example order flow:

```text
AI proposes create_order
 -> n8n calls POST internal orders endpoint with idempotency key
 -> application validates tenant/business/items/stock/required fields
 -> transaction commits
 -> application returns order result
 -> n8n plans confirmation message
 -> outbound queue delivers
```

Same pattern for booking, lead, quote, support case, etc.

## 10. Outbound delivery

n8n should not directly loop through and send 10 images synchronously in the main conversation workflow.

Instead:

```text
Response plan
 -> enqueue outbound jobs
 -> delivery worker
 -> Redis rate limiter
 -> channel adapter
 -> Meta API
```

n8n may receive delivery result events if subsequent orchestration depends on them.

## 11. Media reuse

The legacy project demonstrated reusable Facebook attachment IDs. The target design generalizes this through `channel_media_cache` and the media delivery worker.

n8n references internal `media_asset_id`. It should not need to know whether the actual send used:

- reusable Facebook attachment ID
- WhatsApp media ID
- source media URL
- fresh upload

That is channel/media-adapter responsibility.

## 12. HUMAN mode

Before producing or dispatching an automated reply, workflows re-check conversation mode. This check must occur sufficiently late to avoid races where a human takes over while AI is processing.

Where feasible:

- acquire/consult conversation lock/version
- generate response
- verify mode/version again before enqueue/send

Pending AI jobs should be cancelable/suppressible when HUMAN takeover happens.

## 13. Manual Page-owner echo detection

The legacy workflow compared Facebook message echoes against bot outbound message records so its own API sends did not trigger HUMAN mode. Preserve this behavior in the new architecture using durable outbound message IDs and normalized channel events.

## 14. Follow-up guards

Before sending a scheduled follow-up:

- channel active/connected
- tenant not suspended
- conversation AI-eligible
- not HUMAN mode
- no newer customer response invalidating job
- channel messaging window/policy allows it
- plan/rate limits allow it
- idempotency key not previously completed

## 15. Error handling

Workflows classify errors into categories such as:

- configuration missing/invalid
- authentication/reconnect required
- tenant suspended/limit reached
- provider transient
- provider permanent
- AI format/validation failure
- application action rejected
- media unavailable
- queue unavailable

Errors should emit structured operational events with correlation IDs. Avoid unstructured long error strings as the only diagnostic artifact.

## 16. Idempotency

Every external event and business mutation must carry stable identifiers.

Examples:

- inbound Meta event ID
- platform message ID
- logical turn ID
- order action idempotency key
- outbound delivery idempotency key
- follow-up job unique key
- training job ID

n8n retries must not duplicate durable side effects.

## 17. Workflow versioning

Record expected workflow bundle/version in the platform. Super Admin should detect outdated or missing required workflow versions.

Changing workflow contracts requires compatible API/event changes and migration notes.

## 18. Environment separation

Separate development/staging/production n8n instances or logically isolated environments. Never test production Meta callbacks using development workflows with shared secrets.

## 19. Testing strategy

Workflow tests must cover:

- multi-business routing
- Facebook/Instagram/WhatsApp routing
- trainer identity routing
- HUMAN mode
- duplicate webhook
- screenshot/multi-image turn
- missing prompt/model config
- provider failure/fallback policy
- order/booking idempotency
- follow-up guards
- media cache stale-ID fallback
- queue failure/recovery

## 20. Legacy workflow mapping

From `n8n_local_envirnment`, retain the ideas of:

- modular workflows instead of monolith
- Meta account routing
- account-scoped AI prompt/model behavior
- screenshot/image analysis
- reusable Facebook media attachments
- multi-image responses
- HUMAN/AI handoff
- follow-up guards
- health checks
- safe application-data isolation from n8n internals

Replace:

- Control Spreadsheet
- Operations Spreadsheets
- spreadsheet-to-Postgres sync
- spreadsheet-stored tokens/API keys
- fixed product-sheet schema

with the SaaS API/database/panels described in this repository.

## 21. Acceptance criteria

n8n architecture is complete when all business state can be managed from the SaaS applications without editing workflows, and the same workflow set can safely serve many tenants/businesses/channels through dynamic configuration.