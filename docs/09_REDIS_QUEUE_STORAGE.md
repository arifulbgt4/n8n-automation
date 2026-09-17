# Redis, queues, workers, and media storage

## 1. Redis role

Redis is supporting infrastructure for fast/ephemeral coordination. It is not the durable source of truth.

Primary uses:

- Rate limiting.
- Distributed locks.
- Short-lived conversation aggregation buffers.
- Idempotency/deduplication helper keys with TTL.
- Hot configuration/cache.
- Queue backend/coordination depending on selected library.
- Temporary job/result state.
- Short-lived channel/provider throttling state.

If Redis is lost, durable business data must remain reconstructable from PostgreSQL and media storage.

## 2. Redis tenancy and key discipline

All tenant-related keys use explicit namespace components. Conceptual examples:

```text
rate:{tenant}:{channel}:{scope}
agg:{tenant}:{conversation}
lock:{tenant}:{conversation}
cache:agent:{tenant}:{agent}:{version}
idempotency:{tenant}:{operation}:{key}
```

Do not put raw API keys, access tokens, customer message bodies, or sensitive binary content into key names. Encrypt or avoid sensitive Redis values where required.

## 3. Rate limiter implementation

Use atomic algorithms such as token bucket, fixed/sliding window, or Lua-backed atomic checks depending on requirement.

Required dimensions may include:

- provider/platform account
- tenant
- business
- channel account
- end contact/conversation
- media-specific throughput
- AI task/provider

Rate-limit decisions should return:

- allowed/denied
- remaining units when useful
- retry-after/not-before timestamp
- limiting rule identifier

## 4. Distributed locks

Locks are needed around race-prone operations such as:

- conversation AI vs HUMAN takeover
- aggregation flush
- creating one transaction from retried AI actions
- refreshing a remote media ID
- executing one due follow-up

Locks must have TTL and ownership tokens. Never use an unbounded lock without expiry. Critical correctness should also rely on database constraints/version checks because distributed locks can fail.

## 5. Conversation aggregation buffers

Redis can temporarily collect message IDs for one conversation during the aggregation window.

Durable message bodies/media metadata remain in PostgreSQL/media storage.

Flush operation:

1. Acquire conversation aggregation lock.
2. Read buffered durable message IDs.
3. Verify conversation mode/state.
4. Create one durable `conversation_turn` linking those messages.
5. Clear buffer only after durable turn creation.
6. Enqueue AI processing.

This prevents lost turns if a worker crashes.

## 6. Queue architecture

Use a reliable Redis-backed queue implementation or equivalent job system with:

- delayed jobs
- priorities where supported
- retry/backoff
- job IDs/deduplication
- concurrency controls
- dead-letter/failure states
- worker heartbeats/metrics

Library choice is an implementation decision, but the queue contracts in this document are mandatory.

## 7. Proposed queues

### `inbound-processing`

Processes normalized customer turns after aggregation.

### `outbound-messaging`

Provider-neutral send jobs translated/delivered through channel adapters.

### `media-processing`

Upload/download/metadata/thumbnail/hash/remote provider media handling.

### `ai-jobs`

Longer or separately controlled AI tasks when not executed synchronously through n8n.

### `training-jobs`

Prompt/agent synthesis and evaluation.

### `embedding-jobs`

Chunking/embedding/re-indexing.

### `followup-jobs`

Delayed follow-up checks and sends.

### `analytics-rollup`

Aggregates usage events into dashboard-efficient summaries.

### `maintenance`

Retention cleanup, orphan checks, cache repair, scheduled health work.

Queues may be consolidated initially if operationally simpler, but job types/priorities/concurrency must remain distinguishable.

## 8. Job envelope

Every job should carry identifiers rather than unnecessary full business payloads.

Recommended fields:

- `jobId`
- `jobType`
- `tenantId`
- `businessId` when applicable
- `channelAccountId` when applicable
- `conversationId`/`turnId` when applicable
- target entity/action IDs
- `idempotencyKey`
- correlation/request ID
- created/not-before timestamps
- bounded version/config identifiers

Workers load authoritative current data as required.

## 9. Retries

Retry policy is job-specific.

General requirements:

- Exponential backoff with jitter for transient failures.
- Honor provider `Retry-After` when available.
- No infinite retry loops.
- Non-retryable failures move directly to terminal state.
- Side effects are idempotent across retries.
- Record attempt history safely.

## 10. Dead-letter handling

Jobs that exceed retry limits enter a durable failed/dead-letter view.

Operator tooling must allow:

- inspect sanitized error/context
- retry after configuration fix
- cancel/acknowledge
- group repeated failures

Mass retry requires rate controls to avoid a thundering herd.

## 11. Worker pools

Workers should be independently scalable by workload. Suggested groups:

- messaging workers
- media workers
- AI/training workers
- embeddings workers
- analytics/maintenance workers

Concurrency values are configuration, not hard-coded assumptions.

## 12. Backpressure

When providers/Redis/Postgres/AI services are degraded:

- stop accepting unbounded work into memory
- rely on queue backlog
- lower worker concurrency where appropriate
- expose queue age/depth to operators
- apply tenant fairness controls so one tenant cannot monopolize workers

## 13. Tenant fairness

High-volume tenants must not starve others. Consider:

- per-tenant concurrency caps
- weighted/fair scheduling
- rate-limited enqueueing
- plan-based quotas

Initial implementation may use simpler controls, but metrics must make unfairness detectable.

## 14. Caching strategy

Appropriate Redis caches:

- resolved channel -> tenant/business mapping
- active agent/prompt version metadata
- model/provider config metadata excluding decrypted secrets when possible
- collection schema metadata
- selected read-heavy non-sensitive settings

Use explicit TTL and invalidation events. Correctness must survive stale cache by verifying critical current state at write/action boundaries.

## 15. Cache invalidation

Application mutations emit invalidation signals after commit.

Examples:

- prompt publish -> invalidate agent prompt cache
- channel disable -> invalidate channel routing cache
- collection schema change -> invalidate schema cache
- limit change -> invalidate effective-limit cache

Prefer versioned cache keys for immutable versions when possible.

## 16. Existing OpenMusk/VPS media storage

The planned object/media storage is the existing service exposed at:

`https://admin.openmusk.store/media`

Before production integration, document/implement its actual API capabilities. The application requires a storage adapter with methods equivalent to:

- create/upload asset
- read/download or produce authorized URL
- inspect metadata
- delete/lifecycle asset
- health check

The adapter must hide provider-specific URL/path assumptions from the rest of the codebase.

## 17. Media storage requirements

- Tenant/business namespacing.
- Authentication/authorization for write/delete.
- Unpredictable/non-enumerable public identifiers if public reads are used.
- HTTPS.
- Supported file type/size allowlist.
- Malware/file safety checks appropriate to file types.
- Content hash.
- Metadata extraction.
- Durable backups or replication policy.
- Defined retention/deletion behavior.
- No executable uploads served with unsafe content types.

## 18. Public vs private media

Some Meta APIs may need a provider-accessible HTTPS URL. The storage layer must support controlled delivery without making the entire media store browseable.

Possible patterns:

- public unguessable CDN/storage URL for approved business catalog media
- time-limited signed URL
- authenticated proxy endpoint

Select per provider capability and privacy requirement.

Conversation screenshots/documents may require stricter private access than catalog product images.

## 19. Media processing

On upload/ingestion worker may:

- validate MIME using content, not filename alone
- compute SHA-256 or equivalent hash
- extract dimensions/duration
- optionally generate safe preview/thumbnail
- normalize orientation
- enforce image dimensions/file-size limits
- record processing status

Do not destructively alter original unless product policy explicitly does so.

## 20. Remote channel media reuse

Media worker/channel adapter manages `channel_media_cache` mappings. Use distributed lock per `(asset, channel_account)` while refreshing so several concurrent sends do not upload the same file repeatedly.

## 21. Storage cleanup

Never delete a storage file simply because one collection item stopped referencing it if other records still reference it.

Use reference-aware deletion:

```text
asset marked deleted/unreferenced
 -> grace period
 -> verify no durable references
 -> delete storage object
 -> finalize metadata state
```

Orphan reconciliation jobs compare `app_db` metadata and storage provider inventory when the media service supports it.

## 22. Redis/queue availability failure

If Redis is unavailable:

- web/API should fail gracefully for operations that require async processing
- do not pretend a queued action succeeded if enqueue failed
- provider webhooks should follow a designed durable fallback, such as storing received events/outbox state in PostgreSQL before enqueue retry
- operators receive alerts

## 23. Acceptance criteria

Infrastructure is acceptable when:

- restarting workers does not lose durable jobs/business state
- Redis flush/loss does not erase customer catalog/orders/conversations
- duplicate workers cannot create duplicate orders/sends
- media upload references remain durable across app restarts
- stale Meta media IDs re-upload safely
- one tenant's burst cannot bypass configured limits or indefinitely starve others