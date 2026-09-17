# API, events, and integration contracts

## 1. Contract goals

The API/event layer must let Customer Panel, Super Admin Panel, n8n, and workers share the same business rules without copying application logic into every consumer.

The exact web framework/ORM can be selected during implementation. These contracts are framework-independent.

## 2. API categories

### Customer API

Authenticated tenant-scoped endpoints for:

- account/session/profile.
- tenants/memberships.
- businesses.
- channel accounts/connections.
- dynamic collections/fields/items.
- media.
- conversations/HUMAN mode.
- orders/bookings/leads.
- AI providers/models/agents/prompts.
- training.
- knowledge.
- analytics/usage.
- settings/limits.

### Super Admin API

Platform-authorized endpoints for:

- tenants/users/businesses/channels.
- plans/limits/feature flags.
- usage/cost/health.
- n8n workflow bundle/queue diagnostics.
- support actions.
- audit/security operations.

### Internal service API

Machine-authenticated endpoints used by n8n/workers for:

- resolve runtime context.
- read active agent/data schema.
- execute validated business actions.
- record normalized inbound/outbound events.
- publish delivery results.
- resolve/stream authorized media.
- manage training candidates.
- write usage events.
- query eligible follow-ups.

Internal APIs are not browser-public simply because they use HTTP.

## 3. API conventions

- JSON request/response for structured APIs.
- Stable resource IDs.
- ISO 8601 UTC timestamps.
- Explicit pagination.
- Server-side filter/sort allowlists.
- Structured error codes.
- Correlation/request ID returned in errors.
- Versioning strategy before breaking contracts.

## 4. Error envelope

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

Do not return stack traces, secrets, raw authorization headers, or internal SQL errors to customers.

## 5. Idempotency

Mutation endpoints used by automations support idempotency for duplicate execution:

- create order.
- create booking.
- create lead.
- enqueue outbound response.
- register inbound provider message.
- start training job.

Client supplies `Idempotency-Key` or stable action ID; server recognizes completed/in-progress keys scoped to tenant/operation.

## 6. Optimistic concurrency

Configuration resources support version/update checks, especially prompt publish, collection schema edits, channel settings, limits, and conversation mode.

## 7. Internal runtime context endpoint

n8n/workers resolve a bounded runtime bundle by identifiers:

- tenant/business/channel.
- active agent/profile version.
- applicable AI task configs.
- collection/schema links.
- messaging limits.
- conversation mode.

Avoid returning full catalog databases or secrets when only IDs/settings are needed.

## 8. Business-action endpoints

Examples:

- `create_order`.
- `update_order_status`.
- `create_booking`.
- `reschedule_booking`.
- `create_lead`.
- `create_quote_request`.
- `handoff_conversation`.
- `resume_ai`.

Each action validates tenant scope, enabled capability, current data state, required fields, and idempotency.

## 9. Application media API contract

The SaaS exposes logical media operations independent of infrastructure hostnames/admin interfaces:

- upload/register asset.
- list/get asset metadata.
- get authorized content/stream.
- change allowed visibility where supported.
- delete/request deletion.
- get tenant storage/quota status.
- health/status.

Collection/message APIs refer to `media_asset_id`, never filesystem paths or infrastructure URLs.

The backend storage adapter maps these operations to the existing Media Storage user API:

```text
GET    /api/v1/storage
POST   /api/v1/files
GET    /api/v1/files?limit=<n>&offset=<n>
GET    /api/v1/files/:id
GET    /api/v1/files/:id/content
PATCH  /api/v1/files/:id
DELETE /api/v1/files/:id
```

Media bearer credentials remain server-side. `content_url` returned by storage is treated as service-relative and resolved by the adapter.

## 10. Domain event principles

Events represent facts already committed, not commands that may never have happened.

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

Payload contains enough immutable data/identifiers for consumers but not large records/secrets.

## 12. Transactional outbox

1. Write domain change.
2. Write outbox event in same PostgreSQL transaction.
3. Commit.
4. Dispatcher publishes event/job.
5. Mark dispatch state.

Consumers remain idempotent because events may be delivered more than once.

## 13. Inbound Meta event contract

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

The resolver maps receiving account to the correct tenant/business/channel.

## 14. Outbound response contract

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

- agent profile ID.
- base prompt version ID.
- approved example IDs.
- relevant collection schema IDs/versions.
- capability version.
- selected prompt-synthesis model config.

Output:

- candidate prompt version ID.
- structured evaluation results/warnings.
- usage/cost metadata.

Do not pass decrypted API keys as persistent job payload fields.

## 16. Knowledge indexing contract

Source change event contains source/version IDs. Embedding worker loads content, chunks, creates embeddings, and writes only if source version remains current or records version-specific results.

## 17. Cache invalidation events

Examples:

- `AGENT_PROMPT_PUBLISHED` -> invalidate active agent cache.
- `CHANNEL_SETTINGS_CHANGED` -> invalidate routing/limit cache.
- `COLLECTION_SCHEMA_CHANGED` -> invalidate schema cache.
- `LIMIT_CHANGED` -> invalidate effective-limit cache.

## 18. Webhook endpoints

Public provider endpoints are narrowly scoped and require:

- provider verification method/path.
- signature validation.
- exact supported HTTP methods.
- body-size limits.
- durable event IDs.
- fast acknowledgment.
- structured internal handoff.

## 19. API pagination and bulk operations

Large collections/messages/orders use cursor pagination where practical. Large bulk import/update operations run asynchronously and return job IDs.

## 20. Exports

```text
request export -> authorize -> job -> generated file in Media Storage -> time-limited/authorized download -> audit
```

Exports never include decrypted secrets.

## 21. n8n workflow/deployment contract

n8n workflow JSON bundle versions declare which internal API/event contract versions they support.

Deployment metadata records:

- bundle version.
- target n8n workflow IDs.
- workflow key/version.
- compatible API contract version.
- active deployment state.
- timestamp/actor.

Workflow JSON must not embed environment-specific infrastructure/admin URLs or customer secrets.

## 22. Contract versioning

Events carry integer schema versions. Internal/public APIs have documented compatibility strategy. Database migrations and workflow bundle deployments must preserve compatibility during rollout/cutover.

## 23. Acceptance criteria

- Duplicate `create_order` with same idempotency key does not create another order.
- Committed prompt publish cannot permanently miss cache invalidation due to transient queue outage.
- n8n operates without customer browser sessions or broad database write credentials.
- outbound adapters receive internal asset IDs instead of tenant file paths.
- media storage access remains behind server-side adapter/auth.
- event consumers tolerate duplicate delivery.
- workflow bundle/API contract mismatches are detectable before production activation.