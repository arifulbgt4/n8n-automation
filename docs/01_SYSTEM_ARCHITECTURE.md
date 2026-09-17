# System architecture

## 1. Architecture goal

The platform must remain understandable, secure, and scalable as tenant count, channel count, conversations, media, and AI usage grow. The main design rule is to keep durable business state in the SaaS application layer while n8n and workers execute automation against that state.

## 2. Logical components

```text
+---------------------+        +-----------------------+
| Customer Panel      |        | Super Admin Panel     |
| tenant-facing UI    |        | platform-facing UI    |
+----------+----------+        +-----------+-----------+
           |                               |
           +---------------+---------------+
                           |
                           v
                 +-------------------+
                 | SaaS Backend/API  |
                 | auth/business API |
                 +----+----+----+----+
                      |    |    |
          +-----------+    |    +------------------+
          |                |                       |
          v                v                       v
   +-------------+   +-----------+        +----------------+
   | PostgreSQL  |   | Redis     |        | Media Storage  |
   | app_db      |   | cache/jobs|        | OpenMusk/VPS   |
   +------+------+   +-----+-----+        +--------+-------+
          |                |                       |
          |                v                       |
          |         +-------------+                |
          |         | Workers     |<---------------+
          |         +------+------+ 
          |                |
          +----------------+------------------+
                           |
                           v
                       +-------+
                       | n8n   |
                       +---+---+
                           |
                +----------+----------+
                |          |          |
                v          v          v
             Facebook   Instagram   WhatsApp
```

The diagram is logical, not a requirement that every component run on its own machine from day one.

## 3. Database separation

The PostgreSQL server may initially host both databases, but they are logically independent:

```text
PostgreSQL instance/cluster
|
+-- app_db
|   +-- SaaS users/tenants/businesses
|   +-- channels/catalogs/conversations
|   +-- orders/bookings/leads
|   +-- AI configuration/training
|   +-- usage/audit/events
|
+-- n8n_db
    +-- n8n users
    +-- n8n workflows
    +-- n8n credentials metadata
    +-- n8n executions/internal state
```

### No sync job between databases

`app_db` and `n8n_db` are not two copies of business data. There is nothing to manually or automatically synchronize between them.

When n8n needs business data, it reads it through an approved application API or approved read-only data-access path. When n8n needs to perform a business mutation such as creating an order, it should normally invoke the application service/API so validation, audit, authorization context, idempotency, and side effects remain consistent.

Direct DB reads can be used for performance-sensitive internal operations when the contract explicitly allows them. Direct DB writes should be exceptional and wrapped in well-defined stored/service logic.

## 4. Source-of-truth ownership

| Data | Owner/source of truth |
| --- | --- |
| Users, tenants, roles | `app_db` |
| Businesses and channel accounts | `app_db` |
| Products/services/custom collections | `app_db` |
| Conversations/messages | `app_db` |
| Orders/bookings/leads/quotes | `app_db` |
| AI agents/prompts/providers | `app_db` |
| Training examples/prompt versions | `app_db` |
| Usage/audit/plan assignments | `app_db` |
| Durable media metadata | `app_db` |
| Media binary files | media storage service |
| Queue/in-flight short state | Redis/queue backend |
| Reusable hot cache | Redis |
| n8n workflow definitions/executions | `n8n_db` |

## 5. Web application boundary

Both panels call the backend/API. The browser must not receive direct database credentials, Redis credentials, n8n admin credentials, Meta app secrets, or AI provider secrets.

The customer panel is always tenant-scoped. The super-admin panel uses explicit platform-level authorization and must record sensitive actions in audit logs.

## 6. Backend/API responsibilities

The backend/API is the canonical business-logic layer for:

- Authentication/session validation.
- Tenant/business membership checks.
- RBAC and permission enforcement.
- CRUD for businesses, channels, collections, catalog items, prompts, providers, training configuration, and limits.
- Order/booking/lead validation and state transitions.
- Secret encryption/decryption boundaries.
- Media authorization/presigned or proxied access as supported by the storage service.
- Publishing domain events/jobs after durable commits.
- Audit logging.
- Usage queries for the UI.
- n8n/worker internal service endpoints.

## 7. Event-driven behavior

Changes that require background work create events/jobs after the durable application transaction commits.

Examples:

```text
Channel connected
 -> app_db commit
 -> CHANNEL_CONNECTED event
 -> queue
 -> n8n/worker provisioning/test actions
```

```text
Prompt version published
 -> app_db commit
 -> AGENT_PROMPT_PUBLISHED event
 -> invalidate Redis caches
 -> next conversation uses new version
```

```text
Media asset created
 -> app_db metadata
 -> MEDIA_PROCESS_REQUESTED
 -> worker computes metadata/hash/variants as required
```

The preferred consistency pattern is transactional-outbox or another mechanism that prevents a successful database commit from losing the event that must follow it.

## 8. n8n boundary

n8n is responsible for integration-oriented orchestration:

- Meta webhook workflows where appropriate.
- Calling AI providers or delegating to AI services.
- Coordinating business action flows.
- Triggering follow-ups and scheduled automations.
- Integrating future external services.
- Applying workflow-level orchestration around application APIs and queued tasks.

n8n must not become the only location where critical business rules exist. Rules needed by both UI and automations belong in the application service/domain layer.

## 9. Worker boundary

Dedicated workers are preferred for high-volume, stateful, retryable tasks where n8n is not the best execution primitive:

- Outbound message dispatch.
- Rate-limit enforcement.
- Media fetch/upload/remote-ID reuse.
- Image/file processing.
- Embedding generation.
- Prompt training/synthesis jobs.
- Analytics rollups.
- Retry/dead-letter processing.
- Background cleanup/retention.

n8n may enqueue these tasks and consume results/events.

## 10. Redis boundary

Redis is ephemeral infrastructure, not the durable source of truth. It may hold:

- Rate-limit counters.
- Conversation aggregation buffers.
- Distributed locks.
- Deduplication keys with TTL.
- Job/queue state depending on the selected queue implementation.
- Hot configuration/cache entries.
- Short-lived session helpers where appropriate.

Any value that cannot be reconstructed after Redis loss must also exist durably elsewhere.

## 11. Media storage boundary

The existing VPS media service at `https://admin.openmusk.store/media` is the planned object/media storage endpoint. Application code must not spread direct URL assumptions throughout the product. A storage adapter/service boundary is required so that authorization, tenancy, deduplication, metadata, and future migration to S3-compatible storage remain possible.

## 12. Vector search boundary

pgvector is part of `app_db` initially. Embeddings must be associated with tenant/business and source entity/version. Vector retrieval always includes tenant/business filters before or with similarity search.

## 13. Channel adapter boundary

AI/business logic returns a logical response plan rather than Facebook-specific payloads.

Example logical plan:

```json
{
  "messages": [
    {"type": "text", "text": "Here are three matching items."},
    {"type": "media", "assetId": "..."},
    {"type": "media", "assetId": "..."}
  ]
}
```

Channel adapters translate the plan into Facebook, Instagram, or WhatsApp API calls, respecting each provider's capabilities and limitations.

## 14. Request correlation

Every inbound webhook and background job must carry correlation identifiers sufficient to trace:

- tenant
- business
- channel account
- conversation
- inbound platform event/message
- logical turn
- outbound job/message
- n8n execution where applicable

This is essential for debugging and cost/usage attribution.

## 15. Scalability model

The initial deployment may run several services on one VPS, but boundaries must allow independent scaling later:

```text
web panels -> horizontally scalable
API        -> horizontally scalable
workers    -> horizontally scalable by queue
n8n        -> scale according to n8n mode/queue design
Redis      -> managed/replicated later
Postgres   -> primary + backups/read replicas later
media      -> storage/CDN migration later
```

No customer-facing contract should depend on a single-process in-memory state.