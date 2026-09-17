# System architecture

## 1. Architecture goal

The platform must remain understandable, secure, and scalable as tenant count, channel count, conversations, media, and AI usage grow. Durable business state remains in the SaaS application layer while n8n and workers execute automation against that state.

PostgreSQL, Redis, n8n, and Media Storage are already-running infrastructure services managed outside this application repository. This repository integrates with them through configuration and stable contracts; it does not install or administer them.

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
   | app_db      |   | cache/jobs|        | existing svc   |
   +------+------+   +-----+-----+        +--------+-------+
          |                |                       |
          |                v                       |
          |         +-------------+                |
          |         | Workers     |<---------------+
          |         +------+------+                |
          |                |                       |
          +----------------+-----------------------+
                           |
                           v
                    +-------------+
                    | existing n8n|
                    | runtime     |
                    +------+------+ 
                           |
                +----------+----------+
                |          |          |
                v          v          v
             Facebook   Instagram   WhatsApp
```

The diagram is logical. Runtime hostnames, ports, admin URLs, and infrastructure repository locations are environment details and must not become application constants.

## 3. Database separation

The PostgreSQL service may host both databases, but they are logically independent:

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

When n8n needs business data, it reads it through an approved application API or approved read-only data-access path. When n8n performs a business mutation such as creating an order, it should normally invoke the application service/API so validation, audit, authorization context, idempotency, and side effects remain consistent.

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
| Durable SaaS media metadata/relationships | `app_db` |
| Media binary files and storage-level quota metadata | existing Media Storage service |
| Queue/in-flight short state | Redis/queue backend |
| Reusable hot cache | Redis |
| n8n workflow definitions/executions | n8n runtime / `n8n_db` |
| Version-controlled n8n workflow artifacts | this Git repository |

## 5. Web application boundary

Both panels call the backend/API. Browser code must not receive direct database credentials, Redis credentials, Media Storage bearer keys, n8n admin credentials, Meta app secrets, or AI-provider secrets.

The customer panel is always tenant-scoped. The super-admin panel uses explicit platform-level authorization and records sensitive actions in audit logs.

## 6. Backend/API responsibilities

The backend/API is the canonical business-logic layer for:

- authentication/session validation.
- tenant/business membership checks.
- RBAC and permission enforcement.
- CRUD for businesses, channels, collections, catalog items, prompts, providers, training configuration, and limits.
- order/booking/lead validation and state transitions.
- secret encryption/decryption boundaries.
- server-side Media Storage access and media authorization.
- publishing domain events/jobs after durable commits.
- audit logging.
- usage queries for the UI.
- n8n/worker internal service endpoints.

## 7. Event-driven behavior

Changes that require background work create events/jobs after the durable application transaction commits. Prefer transactional-outbox or equivalent delivery guarantees.

Examples:

```text
Channel connected
 -> app_db commit
 -> CHANNEL_CONNECTED event
 -> queue
 -> worker/n8n validation/provisioning action
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
 -> worker metadata/thumbnail/provider processing
```

## 8. n8n boundary

n8n is responsible for integration-oriented orchestration:

- Meta webhook workflows where appropriate.
- AI/provider orchestration.
- coordinating business action flows through application APIs.
- follow-ups and scheduled automations.
- future external integrations.

n8n must not become the only location where critical business rules exist. Rules needed by both UI and automations belong in the application service/domain layer.

The n8n runtime already exists. This repository owns only the modular workflow JSON bundle, manifest/version metadata, and integration contracts. Workflow import/update/activation is defined in `08_N8N_AUTOMATION.md` and `17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md`.

## 9. Worker boundary

Dedicated workers are preferred for high-volume, stateful, retryable tasks:

- outbound message dispatch.
- rate-limit enforcement.
- media fetch/upload/remote-ID reuse.
- image/file processing.
- embedding generation.
- prompt training/synthesis jobs.
- analytics rollups.
- retry/dead-letter processing.
- cleanup/retention.

n8n may enqueue these tasks and consume results/events.

## 10. Redis boundary

Redis is existing ephemeral infrastructure, not the durable source of truth. This application uses a dedicated key/job namespace for:

- rate-limit counters.
- conversation aggregation buffers.
- distributed locks.
- deduplication keys with TTL.
- queue state depending on selected library.
- hot configuration/cache entries.
- short-lived runtime state.

Any value that cannot be reconstructed after Redis loss must exist durably elsewhere.

## 11. Media Storage boundary

The existing Media Storage service is consumed through a server-side adapter. Infrastructure-specific base URLs and admin routes come from environment/deployment configuration and are not embedded in the domain model.

The service user API provides authenticated upload/list/metadata/content/update/delete operations, storage/quota reporting, per-user bearer keys, public/private visibility, and SHA-256 file checksums.

Preferred tenant isolation maps each SaaS tenant to a dedicated Media Storage user/account. The application stores the external media user/file IDs and encrypted credential reference in `app_db`; customer browsers never receive Media Storage credentials.

## 12. Vector search boundary

pgvector is part of `app_db` initially. Embeddings are associated with tenant/business and source entity/version. Vector retrieval always includes tenant/business filters.

## 13. Channel adapter boundary

AI/business logic returns a logical response plan rather than Facebook-specific payloads.

```json
{
  "messages": [
    {"type": "text", "text": "Here are three matching items."},
    {"type": "media", "assetId": "..."},
    {"type": "media", "assetId": "..."}
  ]
}
```

Channel adapters translate the plan into Facebook, Instagram, or WhatsApp API calls, respecting provider capabilities and limitations.

## 14. Request correlation

Every inbound webhook and background job must carry correlation identifiers sufficient to trace tenant, business, channel, conversation, platform event/message, logical turn, outbound job/message, and n8n execution where applicable.

## 15. Scalability model

Application boundaries must allow independent scaling later:

```text
web panels -> horizontally scalable
API        -> horizontally scalable
workers    -> horizontally scalable by queue
n8n        -> existing runtime scaled by infrastructure owner
Redis      -> existing service, capacity monitored
Postgres   -> existing service, capacity/backups monitored
media      -> existing service, capacity/quota/backups monitored
```

No customer-facing contract should depend on a single-process in-memory state.

## 16. Integration rule

The application repository may add clients, adapters, migrations, workflow JSON, validation, and health checks. It must not add duplicate infrastructure installation as a hidden dependency. All connection-specific details are injected at deployment time.