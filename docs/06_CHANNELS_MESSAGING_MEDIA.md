# Channels, messaging, conversations, and media

## 1. Supported channels

Initial channels:

- Facebook Messenger via connected Facebook Page.
- Instagram messaging for supported professional accounts.
- WhatsApp Business messaging.

The domain model and runtime must support future adapters without changing core conversation, agent, catalog, and transaction models.

## 2. Channel account identity

Every connected channel is a `channel_account` attached to one business.

Runtime routing uses the channel/platform receiving account identity, not merely the parent business ID. Examples:

- Facebook: Page/recipient identity.
- Instagram: receiving professional account identity provided by webhook/API.
- WhatsApp: receiving phone-number ID/business account context.

This is necessary because one tenant may operate multiple businesses and multiple accounts of the same platform.

## 3. Multi-business and shared-data rules

A tenant can have:

```text
Business A
  Facebook Page A
  Instagram A
  WhatsApp A

Business B
  Facebook Page B
  WhatsApp B
```

A collection/catalog belongs to a business and may link to multiple channel accounts in that business. One change to a shared catalog is immediately visible to every linked channel because they all read the same source-of-truth records.

Channel-specific item/agent overrides are optional mappings, not independent copies by default.

## 4. Webhook ingestion pipeline

Canonical inbound flow:

```text
Provider webhook
 -> verify signature/token
 -> normalize event
 -> identify channel account
 -> deduplicate platform event/message
 -> persist raw-safe metadata + normalized message
 -> enqueue/trigger processing
 -> acknowledge provider quickly
```

Webhook handlers must avoid long AI/media work before returning the provider acknowledgment.

Store raw payload only if required for diagnostics/compliance; redact or encrypt sensitive fields and apply retention policy.

## 5. Event normalization

Each platform adapter converts provider-specific payloads into a common internal message envelope containing at least:

- tenant/business/channel account
- provider event/message ID
- sender/contact identity
- message direction/type
- text/caption
- media references
- reply/reaction context
- provider timestamp
- normalized timestamp
- correlation ID

Provider-specific metadata remains available in a constrained metadata field when needed.

## 6. Inbound idempotency

Meta/provider retries must not generate duplicate AI responses, orders, or bookings.

Use durable unique keys such as:

```text
(platform, channel_account_id, platform_event_id/message_id)
```

Processing states should distinguish `received`, `processing`, `processed`, and terminal/retryable failure where useful.

## 7. Conversation resolution

For each inbound message:

1. Resolve channel account.
2. Resolve/create contact within the proper scope.
3. Resolve active conversation according to product rules.
4. Append message.
5. Check HUMAN/AI/PAUSED mode.
6. Check trainer identity before normal production processing.
7. Aggregate into a logical turn if eligible.

Do not merge people across platforms merely because names match.

## 8. Message burst aggregation

Customers may send several short texts or 5-10 screenshots before the real question. Calling AI once per transport message produces poor answers and unnecessary cost.

Use a configurable aggregation window:

```text
message 1 ----+
image 1 ------+
image 2 ------+--> logical conversation turn --> one AI plan
message 4 ----+
question -----+
```

Requirements:

- Per channel/conversation buffer in Redis or equivalent short-lived state.
- Window starts/resets according to documented policy.
- Maximum buffered count/bytes/time to prevent abuse.
- An explicit terminal signal where provider semantics support it.
- Persist every transport message in PostgreSQL; Redis only coordinates grouping.
- One `conversation_turn` records which messages were grouped.

## 9. Screenshot and image understanding

If inbound turn contains screenshots/photos:

- Fetch/download through a secure media ingestion path.
- Persist/reuse as `media_assets` according to retention policy.
- Invoke configured vision model only when required.
- Produce structured observations/search hints.
- Search the business's attached collections/knowledge.
- Ground the answer in matched data; do not treat vision output as authoritative price/stock/service availability.

Multiple screenshots can be analyzed together or in bounded batches depending on model limits and cost.

## 10. Logical response planning

AI/business logic should produce a provider-neutral response plan, e.g.:

```json
{
  "actions": [
    {"type":"send_text","text":"I found these options."},
    {"type":"send_media","assetId":"asset-1"},
    {"type":"send_media","assetId":"asset-2"}
  ]
}
```

The channel adapter decides how to encode/send each action.

The response planner must enforce business/platform policy before jobs enter the delivery queue.

## 11. Multiple image responses

A customer may request several product/service images or "all images".

Rules:

- Determine matching item(s) from current collection data.
- Load active media in configured order.
- Apply `max_images_per_response` and transport/provider limits.
- If more assets exist, send an initial bounded batch and offer/allow continuation.
- Enqueue each transport send separately when the provider requires separate messages.
- Maintain logical response grouping for analytics.

The AI must not bypass configured limits by generating many individual media actions.

## 12. Media storage

Primary planned storage endpoint: `https://admin.openmusk.store/media`.

The application must treat it as a storage provider through an adapter interface. Required capabilities should include:

- Authenticated upload.
- Tenant/business namespacing.
- Stable asset identifier/key.
- Read/download URL or authorized delivery mechanism.
- Delete/lifecycle operation.
- File metadata.
- Error semantics.

If the existing media service does not expose all required APIs, those gaps must be implemented before relying on it as production object storage.

## 13. Media deduplication

On upload/ingestion:

- Compute content hash where feasible.
- Reuse an existing same-tenant asset if policy allows.
- Never leak cross-tenant deduplication information.
- Store original filename/source separately from canonical asset identity.

## 14. Channel media cache

Avoid repeatedly uploading the same business media to Meta when the provider supports reusable uploaded media.

`channel_media_cache` maps:

```text
media_asset_id
+ channel_account_id
+ platform
-> remote_media_id / attachment_id
```

Delivery behavior:

1. Look for valid cached remote media ID.
2. Reuse it if supported.
3. If provider rejects it, mark stale/invalid.
4. Upload source media again.
5. Persist the new remote ID.
6. Retry send under idempotency/retry rules.

Do not assume all provider media IDs are permanent; track status/expiry where known.

## 15. Outbound delivery queue

n8n/AI should create logical outbound intents/jobs; a delivery worker enforces rate limits and retries.

Each outbound message job should include:

- tenant/business/channel/conversation
- logical response/turn ID
- message type/content/asset reference
- priority
- idempotency key
- attempt count
- not-before time
- correlation IDs

Persist final delivery status in `messages`/delivery tables.

## 16. Priorities

Suggested priority ordering:

1. Human staff reply.
2. Active customer-requested transactional confirmation.
3. Active customer-requested AI reply.
4. Normal system message.
5. Follow-up/reminder.
6. Low-priority background notification.

Priority cannot bypass provider safety limits.

## 17. Rate limiting

Limits are layered:

```text
provider/platform ceiling
SaaS safety ceiling
plan quota/limit
super-admin override
business/channel configuration
end-contact/conversation anti-abuse limit
```

Effective runtime rate is the strictest applicable rule.

Track at minimum:

- outbound messages/minute
- burst messages/short interval
- media messages/minute
- images/logical response
- AI turns/hour/day
- estimated/actual tokens/day
- follow-up count/day/contact

Use Redis atomic counters/token buckets/sliding windows as appropriate; durable usage events remain in PostgreSQL.

## 18. HUMAN mode and manual replies

Conversation mode controls AI delivery.

### HUMAN takeover

When staff explicitly takes over or a verified manual Page-owner reply is detected under configured policy:

- acquire conversation lock
- set mode `HUMAN`
- cancel/suppress pending AI replies that have not been dispatched
- record actor/reason
- allow human outbound delivery

### Resume AI

- staff explicitly resumes AI or configured automation does so
- system records transition
- AI receives sufficient recent context and current business data

A HUMAN conversation must block automated follow-up sends unless a dedicated human-approved automation policy says otherwise.

## 19. Detecting manual Page-owner replies

Facebook echoes or provider events may include both bot/API sends and human Page-owner sends. The system must avoid treating its own outbound echo as a human takeover.

Maintain outbound provider message IDs / sent-message records and compare echo events. Only a verified unmatched manual reply should trigger automatic HUMAN mode when that option is enabled.

## 20. Follow-ups

Follow-ups are scheduled jobs with guards:

- conversation still eligible/open
- no HUMAN mode
- no recent customer reply that invalidates the follow-up
- tenant/channel active
- within plan/rate limits
- within channel messaging policy/window
- idempotency prevents duplicates

Follow-up timing/count is configurable within platform ceilings.

## 21. Delivery retries and dead letters

Classify provider errors:

- transient/retryable (timeouts, certain 5xx/rate limits)
- credential/reconnect required
- permanent content/recipient errors
- stale remote media ID (special re-upload path)

Use exponential backoff/jitter for retryable errors. After bounded attempts, send the job to a dead-letter/recovery state and surface it in operator diagnostics.

## 22. Usage metering

Messaging must emit distinct metrics for:

- inbound transport messages
- outbound transport messages
- logical turns
- logical responses
- AI turns/calls
- human replies
- media uploads
- media sends
- remote-media cache hits/misses
- retries/failures

These values must not be conflated.

## 23. Channel disconnect/reconnect

If credentials expire/revoke:

- mark channel degraded/disconnected
- stop unsafe outbound sends
- preserve queued jobs according to bounded policy or fail with reconnect reason
- notify customer UI
- provide reconnect flow
- revalidate webhook/subscription state after reconnect

## 24. Acceptance criteria

Messaging is complete only when tests prove:

- duplicate webhooks do not duplicate replies/actions
- 10 rapid screenshots can become one logical AI turn
- multi-image sends obey configured bounds
- reusable remote media is reused and stale IDs recover
- HUMAN mode reliably blocks AI/follow-ups
- provider rate limits do not cause uncontrolled message loss
- every delivered/failed message is attributable to tenant/business/channel/conversation/job