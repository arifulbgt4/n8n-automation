# API, events, and integration contracts

## 1. Contract goals

The API/event layer must let Customer Panel, Super Admin Panel, n8n, and workers share the same business rules without copying application logic into every consumer.

The exact web framework/ORM can be selected during implementation. The contracts below are framework-independent requirements.

## 2. API categories

### Customer API

Authenticated tenant-scoped endpoints for:

- account/session/profile
- tenants/memberships
- businesses
- channel accounts/connections
- dynamic collections/fields/items
- media
- conversations/HUMAN mode
- orders/bookings/leads
- AI providers/models/agents/prompts
- training
- knowledge
- analytics/usage
- settings/limits

### Super Admin API

Platform-authorized endpoints for:

- tenants/users/businesses/channels
- plans/limits/feature flags
- usage/cost/health
- n8n/queue diagnostics
- support actions
- audit/security operations

### Internal service API

Machine-authenticated endpoints used by n8n/workers for:

- resolve runtime context
- read active agent/data schema
- execute validated business actions
- record normalized inbound/outbound events
- publish delivery results
- manage training candidates
- write usage events
- query eligible follow-ups

Internal APIs are not browser-public simply because they use HTTP.

## 3. API conventions

Recommended conventions:

- JSON request/response for structured APIs.
- Stable resource IDs (UUID/ULID style acceptable).
- ISO 8601 UTC timestamps; business timezone is metadata/presentation.
- Explicit pagination for lists.
- Server-side filtering/sorting allowlists.
- Structured error codes.
- Correlation/request ID returned in errors.
- Versioning strategy before breaking public/internal contracts.

## 4. Error envelope

Conceptual response:

```json
{
  "error": {
    "code": "CHANNEL_REAUTH_REQUIRED",
    "message": "The channel must be reconnected.",
    "details": {},
    "requestId": "..."
  }
}
```

Do not return stack traces, secrets, raw provider authorization headers, or internal SQL errors to customers.

## 5. Idempotency

Mutation endpoints used by automations must support idempotency when duplicate execution is possible.

Examples:

- create order
- create booking
- create lead
- enqueue outbound response
- register inbound provider message
- start training job

Client supplies `Idempotency-Key` or stable action ID. Server stores/recognizes completed/in-progress keys scoped to tenant/operation.

## 6. Optimistic concurrency

Configuration resources that can be edited by multiple users/jobs should support version/update checks, e.g. `version`, `updated_at`, or ETag-style semantics.

Especially important for:

- prompt publish
- collection schema edits
- channel settings
- limits
- conversation HUMAN/AI mode

## 7. Internal runtime context endpoint

n8n/worker should be able to resolve a bounded runtime bundle by identifiers:

- tenant/business/channel
- active agent/profile version
- applicable AI task configs
- collection/schema links
- messaging limits
- conversation mode

Avoid returning entire catalog databases or full secrets when only IDs/settings are needed.

## 8. Business-action endpoints

Examples of application-owned actions:

- `create_order`
- `update_order_status`
- `create_booking`
- `reschedule_booking`
- `create_lead`
- `create_quote_request`
- `handoff_conversation`
- `resume_ai`

Each action validates tenant scope, enabled capability, data state, required fields, and idempotency.

## 9. Media API contract

Application storage service/adapter should expose logical operations independent of the OpenMusk endpoint implementation:

- initiate/upload asset
- finalize/register asset
- get authorized media URL/stream
- delete/request deletion
- list asset metadata
- health check

Collection/message APIs refer to `media_asset_id`, not arbitrary filesystem paths.

## 10. Domain event principles

Events represent facts that already committed, not commands that may never have happened.

Examples:

- `TENANT_CREATED`
- `BUSINESS_CREATED`
- `CHANNEL_CONNECTED`
- `CHANNEL_DISCONNECTED`
- `COLLECTION_SCHEMA_CHANGED`
- `COLLECTION_ITEM_CHANGED`
- `MESSAGE_RECEIVED`
- `TURN_READY`
- `CONVERSATION_MODE_CHANGED`
- `ORDER_CREATED`
- `BOOKING_CREATED`
- `AGENT_PROMPT_PUBLISHED`
- `TRAINING_CANDIDATE_CREATED`
- `KNOWLEDGE_SOURCE_CHANGED`
- `MEDIA_ASSET_CREATED`
- `LIMIT_CHANGED`

## 11. Event envelope

Recommended fields:

```json
{
  "eventId": "uuid",
  "eventType": "ORDER_CREATED",
  "version": 1,
  "occurredAt": "2026-09-18T00:00:00Z",
  "tenantId": "...",
  "businessId": "...",
  "resourceId": "...",
  "correlationId": "...",
  "payload": {}
}
```

Payload must contain enough immutable data/identifiers for the consumer but should not duplicate large records/secrets.

## 12. Transactional outbox

For database changes requiring events:

1. Write domain change.
2. Write outbox event in the same PostgreSQL transaction.
3. Commit.
4. Dispatcher publishes event/job.
5. Mark dispatch state.

This avoids the failure mode where the DB change succeeds but the queue/event publish is lost.

Consumers are still idempotent because events may be delivered more than once.

## 13. Inbound Meta event contract

Normalize provider event before business processing.

Conceptual envelope:

```json
{
  "platform": "facebook",
  "channelExternalId": "...",
  "eventId": "...",
  "messageId": "...",
  "senderExternalId": "...",
  "type": "text|image|audio|...",
  "text": "...",
  "media": [],
  "providerTimestamp": "...",
  "metadata": {}
}
```

The resolver maps the receiving account to the correct tenant/business/channel record.

## 14. Outbound response contract

AI/n8n creates provider-neutral intents:

```json
{
  "conversationId": "...",
  "logicalResponseId": "...",
  "messages": [
    {"type": "text", "text": "..."},
    {"type": "media", "assetId": "...", "caption": null}
  ],
  "priority": "CUSTOMER_ACTIVE",
  "idempotencyKey": "..."
}
```

Messaging service validates current mode/channel/limits before dispatch.

## 15. Training job contract

Inputs reference:

- agent profile ID
- base prompt version ID
- approved example IDs
- relevant collection schema IDs/versions
- capability version
- selected prompt-synthesis model config

Output:

- candidate prompt version ID
- structured evaluation/check results
- warnings
- usage/cost metadata

Do not pass decrypted API keys as persistent job payload fields.

## 16. Knowledge indexing contract

Source change event contains source/version IDs. Embedding worker loads content, chunks, creates embeddings, and writes only if source version remains current or records version-specific results.

## 17. Cache invalidation events

Examples:

- `AGENT_PROMPT_PUBLISHED` -> invalidate active agent cache.
- `CHANNEL_SETTINGS_CHANGED` -> invalidate routing/limit cache.
- `COLLECTION_SCHEMA_CHANGED` -> invalidate schema cache.
- `LIMIT_CHANGED` -> invalidate effective-limit cache.

Prefer versioned immutable cache entries where possible.

## 18. Webhook endpoints

Public provider endpoints are narrowly scoped and do not expose general internal APIs.

Requirements:

- provider verification method/path
- signature validation
- exact supported HTTP methods
- body-size limits
- durable event IDs
- fast acknowledgment
- structured internal handoff

## 19. API pagination and bulk operations

Large collections/messages/orders use cursor pagination where practical. Bulk import/update endpoints run asynchronously for large workloads and return a job ID rather than holding a request open indefinitely.

## 20. Exports

Large exports are asynchronous:

```text
request export -> authorization -> job -> generated file in media/storage -> short-lived authorized download -> audit
```

Exports never include decrypted secret values.

## 21. Contract versioning

Events carry integer schema versions. Internal/public APIs need a documented compatibility strategy. n8n workflow versions declare which event/API contract versions they support.

## 22. Acceptance criteria

- A duplicate `create_order` request with same idempotency key returns the same semantic result without another order.
- A committed prompt publish cannot permanently miss its cache invalidation/event due to a transient queue outage.
- n8n can operate without direct access to customer browser sessions.
- outbound adapters receive internal asset IDs instead of arbitrary tenant file paths.
- event consumers tolerate duplicate delivery.