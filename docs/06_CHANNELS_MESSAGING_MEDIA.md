# Channels, messaging, conversations, and media

## 1. Supported channels

Initial channels:

- Facebook Messenger via connected Facebook Page.
- Instagram messaging for supported professional accounts.
- WhatsApp Business messaging.

The domain model/runtime must support future adapters without changing core conversation, agent, catalog, and transaction models.

## 2. Channel account identity

Every connected channel is a `channel_account` attached to one business.

Runtime routing uses the channel/platform receiving account identity, not merely the parent business ID:

- Facebook: Page/recipient identity.
- Instagram: receiving professional account identity provided by webhook/API.
- WhatsApp: receiving phone-number ID/business account context.

This supports one tenant operating multiple businesses and multiple accounts of the same platform.

## 3. Multi-business and shared-data rules

```text
Business A
  Facebook Page A
  Instagram A
  WhatsApp A

Business B
  Facebook Page B
  WhatsApp B
```

A collection/catalog belongs to a business and may link to multiple channel accounts in that business. One change to shared data is immediately visible to every linked channel because they all read the same source-of-truth records.

Channel-specific item/agent overrides are optional mappings, not independent copies by default.

## 4. Webhook ingestion pipeline

```text
Provider webhook
 -> verify signature/token
 -> normalize event
 -> identify channel account
 -> deduplicate platform event/message
 -> persist safe raw metadata + normalized message
 -> enqueue/trigger processing
 -> acknowledge provider quickly
```

Webhook handlers avoid long AI/media work before provider acknowledgment.

## 5. Event normalization

Each platform adapter converts provider-specific payloads into a common internal message envelope containing at least:

- tenant/business/channel account
- provider event/message ID
- sender/contact identity
- direction/type
- text/caption
- media references
- reply/reaction context
- provider timestamp
- normalized timestamp
- correlation ID

Provider-specific metadata remains available in constrained metadata when needed.

## 6. Inbound idempotency

Provider retries must not generate duplicate AI responses, orders, or bookings.

Durable uniqueness example:

```text
(platform, channel_account_id, platform_event_id/message_id)
```

Processing states may distinguish `received`, `processing`, `processed`, and terminal/retryable failure.

## 7. Conversation resolution

For each inbound message:

1. Resolve channel account.
2. Resolve/create contact in the correct scope.
3. Resolve active conversation.
4. Append message.
5. Check HUMAN/AI/PAUSED mode.
6. Check trainer identity before production processing.
7. Aggregate into a logical turn if eligible.

Do not merge people across platforms merely because names match.

## 8. Message burst aggregation

Customers may send several short texts or 5-10 screenshots before the real question. Calling AI once per transport message produces poor answers and unnecessary cost.

```text
message 1 ----+
image 1 ------+
image 2 ------+--> logical conversation turn --> one AI plan
message 4 ----+
question -----+
```

Requirements:

- per channel/conversation buffer in Redis.
- documented window/reset policy.
- maximum buffered count/bytes/time.
- persist every transport message in PostgreSQL; Redis coordinates grouping only.
- one `conversation_turn` records grouped messages.

## 9. Screenshot and image understanding

For inbound screenshots/photos:

- fetch through the provider's authenticated media path.
- ingest into Media Storage as private by default.
- create `media_assets` and message links.
- invoke configured vision model only when required.
- produce structured observations/search hints.
- search attached business collections/knowledge.
- ground price/stock/service availability in current application data, not vision guesses.

Multiple screenshots may be analyzed together or in bounded batches based on model limits/cost.

## 10. Logical response planning

AI/business logic produces a provider-neutral response plan:

```json
{
  "actions": [
    {"type":"send_text","text":"I found these options."},
    {"type":"send_media","assetId":"asset-1"},
    {"type":"send_media","assetId":"asset-2"}
  ]
}
```

The channel adapter decides how to encode/send each action. Policy/limits are enforced before jobs enter delivery.

## 11. Multiple-image responses

When a customer requests several product/service images or "all images":

- determine matching item(s) from current data.
- load active media in configured order.
- apply `max_images_per_response` and provider limits.
- if more assets exist, send a bounded initial batch and allow continuation.
- enqueue each transport send separately when required by provider.
- maintain logical response grouping for analytics.

AI cannot bypass configured limits by generating many individual media actions.

## 12. Existing Media Storage integration

Media binaries are stored in the already-running multi-user Media Storage service. This application does not install or administer that service.

The application uses a server-side storage adapter with a configured base URL and tenant-scoped bearer credential. No infrastructure/admin URL is hard-coded into domain code or canonical documentation.

Authenticated user API operations used by the adapter:

```text
GET    /api/v1/storage
POST   /api/v1/files
GET    /api/v1/files?limit=<n>&offset=<n>
GET    /api/v1/files/:id
GET    /api/v1/files/:id/content
PATCH  /api/v1/files/:id
DELETE /api/v1/files/:id
```

Upload uses multipart form data:

```text
file        required
visibility  private | public
```

Returned media metadata includes an external file ID, original filename, MIME type, extension, size, kind, visibility, SHA-256 checksum, nullable public URL, authenticated content path, and creation time.

## 13. Media tenant isolation

Preferred mapping:

```text
SaaS tenant -> dedicated Media Storage user -> dedicated bearer key
```

The server stores the mapping/credential reference securely. Customer/browser code never receives the media bearer key.

Media Storage per-user quotas can mirror or cap SaaS plan storage quotas. Application-level usage/plan checks and storage-service quota checks are both honored.

## 14. Private and public media policy

Default private:

- customer screenshots.
- inbound attachments.
- training media.
- private documents.

Public visibility may be used for approved catalog/business media when a provider needs a provider-fetchable HTTPS URL and policy permits it.

If public access is not appropriate, the delivery path fetches authenticated binary content server-side and uploads it to the channel provider.

## 15. Media deduplication

The Media Storage service already produces SHA-256 checksum metadata. The application can use that checksum to detect duplicate assets within the allowed tenant scope.

Rules:

- dedup only within an authorized ownership scope.
- never reveal that another tenant has an identical file.
- keep original filename/source separately from canonical asset identity.
- avoid re-uploading to Media Storage when an existing same-tenant asset is intentionally reused.

## 16. Channel media cache

Avoid repeatedly uploading the same business media to Meta when reusable remote media identifiers are supported.

`channel_media_cache` maps:

```text
media_asset_id
+ channel_account_id
+ platform
-> remote_media_id / attachment_id
```

Delivery behavior:

1. Resolve `media_asset`.
2. Look for valid cached remote media ID.
3. Reuse when supported.
4. If provider rejects it, mark stale/invalid.
5. Acquire refresh lock for `(asset, channel_account)`.
6. Fetch binary from Media Storage or use approved public URL.
7. Upload once to provider.
8. Persist new remote ID.
9. Retry send under idempotency policy.

Do not assume all provider media IDs are permanent; track expiry/status where known.

## 17. Outbound delivery queue

n8n/AI creates logical outbound intents; a delivery worker enforces rate limits and retries.

Each outbound message job includes:

- tenant/business/channel/conversation
- logical response/turn ID
- message type/content/asset reference
- priority
- idempotency key
- attempt count
- not-before time
- correlation IDs

Persist final delivery status in message/delivery tables.

## 18. Priorities

Suggested ordering:

1. Human staff reply.
2. Active customer-requested transactional confirmation.
3. Active customer-requested AI reply.
4. Normal system message.
5. Follow-up/reminder.
6. Low-priority background notification.

Priority cannot bypass provider safety limits.

## 19. Rate limiting

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

- outbound messages/minute.
- burst messages/short interval.
- media messages/minute.
- images/logical response.
- AI turns/hour/day.
- estimated/actual tokens/day.
- follow-up count/day/contact.

Use Redis atomic counters/token buckets/sliding windows as appropriate; durable usage events remain in PostgreSQL.

## 20. HUMAN mode and manual replies

When staff explicitly takes over or a verified manual Page-owner reply is detected:

- acquire conversation lock.
- set mode `HUMAN`.
- cancel/suppress pending AI replies not dispatched.
- record actor/reason.
- allow human outbound delivery.

When staff resumes AI, record transition and provide sufficient recent context/current business data.

A HUMAN conversation blocks automated follow-ups unless an explicit approved policy says otherwise.

## 21. Detecting manual Page-owner replies

Facebook echoes/provider events may include both API sends and human Page-owner sends. Maintain outbound provider message IDs and compare echo events. Only a verified unmatched manual reply triggers automatic HUMAN mode when enabled.

## 22. Follow-ups

Follow-up jobs check immediately before send:

- conversation still eligible/open.
- not HUMAN mode.
- no newer customer response invalidating follow-up.
- tenant/channel active.
- plan/rate limits permit send.
- provider messaging window/policy permits send.
- idempotency key not already completed.

## 23. Delivery retries and dead letters

Classify provider errors:

- transient/retryable.
- credential/reconnect required.
- permanent content/recipient error.
- stale remote media ID with special re-upload path.
- Media Storage unavailable/quota exceeded/file missing.

Use bounded exponential backoff/jitter. Terminal failures enter dead-letter/recovery state and are visible to operators.

## 24. Media deletion

Application media deletion is reference-aware:

```text
mark/delete request
 -> verify ownership/references
 -> optional grace period
 -> delete Media Storage file
 -> finalize app_db media state
```

A Media Storage hard delete frees local storage/quota but does not remove copies previously uploaded to Facebook/Instagram/WhatsApp. External provider cleanup is separate.

## 25. Usage metering

Messaging emits distinct metrics for:

- inbound transport messages.
- outbound transport messages.
- logical turns/responses.
- AI turns/calls.
- human replies.
- Media Storage uploads/deletes/bytes.
- provider media uploads/sends.
- remote-media cache hits/misses.
- retries/failures.

These values must not be conflated.

## 26. Channel disconnect/reconnect

If credentials expire/revoke:

- mark channel degraded/disconnected.
- stop unsafe outbound sends.
- preserve/fail queued jobs according to bounded policy.
- notify customer UI.
- provide reconnect flow.
- revalidate webhook/subscription state.

## 27. Acceptance criteria

Messaging is complete only when tests prove:

- duplicate webhooks do not duplicate replies/actions.
- 10 rapid screenshots can become one logical AI turn.
- inbound screenshots are stored privately by default.
- multi-image sends obey configured bounds.
- reusable remote media is reused and stale IDs recover.
- Media Storage bearer keys never reach browser/client logs.
- storage quota errors are surfaced safely.
- HUMAN mode reliably blocks AI/follow-ups.
- provider rate limits do not cause uncontrolled message loss.
- every delivered/failed message is attributable to tenant/business/channel/conversation/job.