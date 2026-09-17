# Redis, queues, workers, and media storage

## 1. Existing infrastructure rule

Redis and the Media Storage service already exist outside this application repository. The implementation work here is to configure clients/namespaces, build queue/worker behavior, and build the Media Storage adapter. Do not add duplicate installation/provisioning as an application task.

All service endpoints/credentials come from deployment configuration; infrastructure repository paths and admin URLs are not architecture constants.

## 2. Redis role

Redis is supporting infrastructure for fast/ephemeral coordination. It is not the durable source of truth.

Primary uses:

- rate limiting.
- distributed locks.
- short-lived conversation aggregation buffers.
- idempotency/deduplication helper keys with TTL.
- hot configuration/cache.
- queue backend/coordination.
- temporary job/result state.
- channel/provider throttling state.

If Redis is lost, durable business data remains reconstructable from PostgreSQL and Media Storage.

## 3. Redis namespace discipline

All application-owned keys use an explicit environment/application prefix plus tenant/scope components.

Conceptual examples:

```text
n8nauto:{env}:rate:{tenant}:{channel}:{scope}
n8nauto:{env}:agg:{tenant}:{conversation}
n8nauto:{env}:lock:{tenant}:{conversation}
n8nauto:{env}:cache:agent:{tenant}:{agent}:{version}
n8nauto:{env}:idempotency:{tenant}:{operation}:{key}
```

Do not put raw API keys, access tokens, customer message bodies, or sensitive binary content into key names.

## 4. Rate limiter implementation

Use atomic token bucket, fixed/sliding window, or Lua-backed checks as appropriate.

Dimensions may include:

- provider/platform account.
- tenant.
- business.
- channel account.
- end contact/conversation.
- media-specific throughput.
- AI task/provider.

A decision should return allowed/denied, retry/not-before timing, and limiting rule identifier; remaining units are useful where reliable.

## 5. Distributed locks

Locks are needed around race-prone operations:

- conversation AI vs HUMAN takeover.
- aggregation flush.
- idempotent transaction/action creation.
- remote media ID refresh.
- one due follow-up execution.

Locks require TTL and ownership tokens. Critical correctness also relies on database constraints/version checks.

## 6. Conversation aggregation buffers

Redis temporarily collects durable message IDs for one conversation.

Flush:

1. acquire aggregation lock.
2. read buffered message IDs.
3. verify conversation state/mode.
4. create durable `conversation_turn`.
5. clear buffer only after durable commit.
6. enqueue AI processing.

Durable message bodies/media metadata remain in PostgreSQL/Media Storage.

## 7. Queue architecture

Use a reliable Redis-backed queue implementation with:

- delayed jobs.
- priority where supported.
- retry/backoff.
- stable job IDs/deduplication.
- concurrency controls.
- dead-letter/failure states.
- worker heartbeat/metrics.

Library choice is implementation-specific; the contracts are mandatory.

## 8. Proposed queues

### `inbound-processing`
Normalized turns after aggregation.

### `outbound-messaging`
Provider-neutral send jobs translated by channel adapters.

### `media-processing`
Media ingestion, metadata/thumbnail work, provider media upload/cache handling.

### `ai-jobs`
Longer or independently controlled AI tasks.

### `training-jobs`
Prompt/agent synthesis/evaluation.

### `embedding-jobs`
Chunking/embedding/re-indexing.

### `followup-jobs`
Delayed follow-up checks/sends.

### `analytics-rollup`
Usage aggregation.

### `maintenance`
Retention, orphan checks, cache repair, scheduled health work.

Queues may be consolidated initially, but job types/priorities/concurrency remain distinguishable.

## 9. Job envelope

Carry identifiers instead of unnecessary business payloads:

- `jobId`
- `jobType`
- `tenantId`
- `businessId` where applicable
- `channelAccountId` where applicable
- `conversationId`/`turnId` where applicable
- target entity/action IDs
- `idempotencyKey`
- correlation/request ID
- created/not-before timestamps
- bounded config/version identifiers

Workers load authoritative current state as required.

## 10. Retries and dead letters

General retry rules:

- exponential backoff with jitter for transient failures.
- honor provider `Retry-After` when available.
- no infinite retry loops.
- non-retryable failures terminate immediately.
- side effects idempotent across retries.
- record safe attempt history.

Dead-letter tooling allows inspect, retry after configuration fix, cancel/acknowledge, and repeated-failure grouping. Mass retry is rate controlled.

## 11. Worker pools

Suggested independent scaling groups:

- messaging workers.
- media workers.
- AI/training workers.
- embeddings workers.
- analytics/maintenance workers.

Concurrency is configuration, not a hard-coded assumption.

## 12. Backpressure and tenant fairness

When providers/Redis/Postgres/AI services degrade:

- stop unbounded in-memory intake.
- rely on durable ingest/outbox + queue backlog.
- lower worker concurrency as needed.
- expose queue age/depth.
- prevent one high-volume tenant from starving others.

Consider per-tenant concurrency caps, weighted/fair scheduling, and plan-based quotas.

## 13. Caching strategy

Appropriate Redis caches:

- resolved channel -> tenant/business mapping.
- active agent/prompt metadata.
- model/provider config metadata excluding decrypted secrets when possible.
- collection schema metadata.
- selected read-heavy non-sensitive settings.

Use explicit TTL/invalidation events. Correctness must survive stale cache at critical action boundaries.

## 14. Cache invalidation

Examples:

- prompt publish -> invalidate prompt/agent cache.
- channel disable -> invalidate routing cache.
- collection schema change -> invalidate schema cache.
- limit change -> invalidate effective-limit cache.

Prefer immutable/versioned cache keys when possible.

## 15. Media Storage service capabilities

The existing service is multi-user and supports:

- bearer key per media user.
- optional user quota.
- authenticated upload/list/metadata/content/delete.
- private/public visibility.
- optional public URL for public files.
- hard file deletion with quota accounting.
- SHA-256 checksum.
- MIME/extension validation.
- storage usage endpoint.

The application uses only the media user API through a storage adapter. Infrastructure admin APIs/tokens are not application runtime dependencies.

## 16. Storage adapter interface

Application-facing interface should provide methods equivalent to:

```text
getUsage()
upload(file, visibility)
list({limit, offset})
getMetadata(storageFileId)
getContent(storageFileId)
setVisibility(storageFileId, visibility)
delete(storageFileId)
health()
```

Internally the adapter maps to configured Media Storage endpoints. Other application code must not assemble storage URLs manually.

## 17. Media tenant mapping

Preferred isolation:

```text
tenant -> tenant_media_account -> external media user + encrypted API credential
```

One tenant's server-side credential must never be used to list/read another tenant's files.

Media Storage quota can be aligned with plan quota. The effective upload allowance is constrained by both SaaS plan policy and Media Storage quota/host reserve.

## 18. Upload and metadata mapping

Upload uses multipart form data with required `file` and optional `visibility` (`private` or `public`).

The Media Storage response provides fields equivalent to:

- external file ID.
- media user ID.
- original name.
- MIME type/extension.
- byte size.
- kind.
- visibility.
- SHA-256 checksum.
- optional public URL.
- authenticated content path.
- created timestamp.

Persist external identifiers/checksum/metadata into `media_assets`. Do not duplicate binary data in PostgreSQL.

## 19. Public vs private media

Private by default for screenshots, conversations, training attachments, and sensitive documents.

Public is allowed only for approved business/catalog media when external provider fetching requires it and business/privacy policy allows it.

For private media sent to Meta, workers/n8n fetch authenticated binary content server-side and upload it to the provider.

## 20. Media processing

On upload/ingestion the service already validates file types and produces checksum metadata. Application workers may additionally:

- extract dimensions/duration.
- generate safe previews/thumbnails where product needs them.
- normalize orientation.
- perform policy/security scanning where required.
- record processing state.

Do not destructively alter originals unless policy explicitly allows it.

## 21. Remote channel media reuse

A media worker/channel adapter manages `channel_media_cache`.

Use a distributed lock per `(asset, channel_account)` during refresh so concurrent sends do not re-upload the same binary.

```text
resolve asset
 -> valid remote ID? reuse
 -> stale/missing? fetch binary/public descriptor from Media Storage
 -> provider upload
 -> persist remote ID
 -> send
```

## 22. Storage deletion

Never delete a Media Storage file simply because one collection item stops referencing it if other records still reference the asset.

Reference-aware lifecycle:

```text
asset marked deleted/unreferenced
 -> optional grace period
 -> verify no durable references
 -> delete Media Storage file
 -> finalize app_db metadata state
```

External provider copies are not removed automatically by local Media Storage deletion.

## 23. Backup implication

A complete media restore requires both Media Storage metadata/database backup and physical file storage backup. `app_db` only contains application references and relationships.

## 24. Redis/queue availability failure

If Redis is unavailable:

- API fails gracefully for operations requiring async processing.
- never pretend enqueue succeeded when it failed.
- provider webhook ingestion uses a durable fallback/outbox so accepted events are not lost.
- operators receive alerts.

## 25. Acceptance criteria

Infrastructure integration is acceptable when:

- the application does not attempt to install Redis or Media Storage.
- Redis flush/loss does not erase customer catalog/orders/conversations.
- worker restart does not lose durable business state/jobs requiring recovery.
- duplicate workers cannot create duplicate orders/sends.
- Media Storage upload/list/read/delete works through the adapter.
- media credential remains server-side and tenant-scoped.
- media references survive application restarts.
- stale provider media IDs re-upload safely.
- one tenant's burst cannot bypass configured limits or indefinitely starve others.