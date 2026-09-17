# Domain and database specification

## 1. Database choice

PostgreSQL is the primary database. The application uses relational tables for identities, ownership, transactions, and relationships; JSONB for tenant-defined flexible fields/configuration; and pgvector for embeddings.

The SaaS database is referred to as `app_db`. The n8n internal database remains separate.

## 2. Top-level ownership model

```text
User
  |
Membership
  |
Tenant
  |
Business
  +-- Channel Accounts
  +-- Collections/Catalogs
  +-- Agent Profiles
  +-- Conversations
  +-- Business Actions
```

Every tenant-owned table must have a clear path to `tenant_id`. Where practical, high-volume tables should carry `tenant_id` directly even if it can be derived through joins, because it improves authorization filtering, indexing, partitioning options, and incident analysis.

## 3. Core identity and tenancy tables

### `users`

Represents a human account.

Suggested fields:

- `id` UUID
- `email` normalized unique
- `password_hash` or external auth subject
- `email_verified_at`
- `status` (`active`, `invited`, `suspended`, `disabled`)
- `name`
- `last_login_at`
- `created_at`, `updated_at`

### `tenants`

Represents a customer organization/account boundary.

- `id`
- `name`
- `slug`
- `status`
- `plan_id` nullable
- `settings_json`
- timestamps

### `tenant_memberships`

Many-to-many user membership.

- `tenant_id`
- `user_id`
- `role`
- `status`
- invitation metadata
- timestamps

Initial roles: `OWNER`, `ADMIN`, `STAFF`, `VIEWER`. Fine-grained permissions may later augment roles.

### `platform_admins` or equivalent elevated assignment

Super-admin access is separated from tenant membership. Do not represent super-admin capability by placing a special tenant role on a normal tenant membership.

## 4. Business and channel tables

### `businesses`

- `id`
- `tenant_id`
- `name`
- `business_type_hint` nullable; informational only, not a rigid behavior switch
- locale/timezone/currency defaults
- status
- settings JSONB
- timestamps

### `channel_accounts`

One connected endpoint: Facebook Page, Instagram professional account, WhatsApp business number, future Telegram/web chat/etc.

- `id`
- `tenant_id`
- `business_id`
- `platform` enum/string
- `name`
- `external_account_id`
- platform-specific public identifiers
- encrypted credential reference(s)
- connection status
- graph/API version where applicable
- channel settings JSONB
- default agent profile ID nullable
- active flag
- timestamps

Unique keys must prevent accidental duplicate attachment of the same external account where business rules forbid it.

### `channel_credentials`

Credentials may be modeled separately from `channel_accounts` to isolate encryption/rotation metadata.

Never store secrets in logs. Store encrypted values or references to a secret service.

## 5. Dynamic collections and catalogs

The platform supports arbitrary business datasets without tenant-created physical tables.

### `collections`

- `id`
- `tenant_id`
- `business_id`
- `name`
- `key`
- `purpose` optional (`catalog`, `service`, `property`, `knowledge`, `custom`)
- `is_transactional_source`
- status
- timestamps

A collection may represent products, services, properties, packages, courses, menu items, or custom entities.

### `collection_fields`

Defines the schema displayed in the Customer Panel.

- `id`
- `collection_id`
- `key`
- `label`
- `type`
- `required`
- `unique_within_collection` optional
- `searchable`
- `filterable`
- `sortable`
- `ai_visible`
- `default_value_json`
- `validation_json`
- `options_json`
- display order
- timestamps

Initial field types should include:

- short text
- long text/rich text
- integer/decimal
- currency
- boolean
- date/date-time
- email/phone
- URL
- single select
- multi-select
- media/image
- relation/reference
- JSON/structured advanced field where explicitly permitted

### `collection_items`

- `id`
- `tenant_id`
- `business_id`
- `collection_id`
- `title` optional normalized display name
- `status`
- `data_jsonb`
- timestamps

`data_jsonb` stores tenant-defined field values. Validation occurs against `collection_fields` before commit.

Frequently queried standard attributes may have optional generated/indexed columns later, but the customer-facing model remains dynamic.

### `collection_item_media`

Links collection items to durable media assets with ordering and role (`primary`, `gallery`, `document`, etc.).

### `collection_channel_links`

Many-to-many mapping from a collection to channel accounts.

This enables one catalog/service list to serve Facebook + WhatsApp + Instagram simultaneously, or different datasets per channel.

### `collection_item_channel_overrides`

Optional channel-specific overrides such as active/hidden, channel price, channel alias, or channel-specific copy. Base data remains shared.

## 6. Transactional action model

The platform should support first-class standard entities for common actions, plus extensibility for future actions.

### Orders

`orders`
- tenant/business/customer/channel/conversation references
- external/internal order number
- status
- currency/totals
- customer contact snapshot
- delivery/payment metadata
- source (`ai`, `human`, `api`, `panel`)
- timestamps

`order_items`
- order ID
- source collection/item ID nullable to preserve history if item is removed
- title/SKU/variant snapshot
- quantity
- unit price/totals
- item attributes snapshot

Historical orders must preserve what was purchased even if current catalog data changes.

### Bookings / appointments

`bookings`
- business/channel/conversation/customer
- selected service/item
- start/end/timezone
- status
- participant/contact data
- notes/metadata

### Leads

`leads`
- source channel/conversation
- identity/contact
- interest/context
- stage/status
- assigned user/staff nullable
- metadata

### Quote requests / support cases

Use dedicated tables when the feature becomes first-class. Avoid forcing every business action into an opaque JSON event if the UI/reporting needs strong semantics.

## 7. Conversation domain

### `contacts`

A platform/customer identity resolved within a tenant/business/channel context.

- platform sender ID/phone/etc.
- normalized contact details where available
- optional cross-channel identity links only when legally and reliably established

Do not assume the same human can always be merged across Facebook, Instagram, and WhatsApp.

### `conversations`

- tenant/business/channel account/contact
- mode (`AI`, `HUMAN`, optionally `PAUSED`)
- status (`open`, `closed`, etc.)
- assigned staff
- active agent profile/version
- last message/turn timestamps
- escalation metadata

### `messages`

Each transport message/event:

- `platform_message_id`
- direction (`INBOUND`, `OUTBOUND`)
- sender type (`CONTACT`, `AI`, `HUMAN`, `SYSTEM`)
- message type
- text/content metadata
- delivery status
- logical turn ID
- reply/reaction references
- timestamps

Use a unique constraint on platform/account/message identifiers for inbound idempotency.

### `conversation_turns`

Groups one or more transport messages into a logical AI/human turn. Critical for burst aggregation and accurate AI-turn metering.

### `message_media`

Links messages to `media_assets`.

## 8. Media domain

### `media_assets`

- `id`
- `tenant_id`
- `business_id` nullable when tenant-global
- storage provider/key/path
- canonical URL or access descriptor
- MIME type
- byte size
- width/height/duration where relevant
- content hash
- original filename
- source/type
- processing status
- timestamps

Use content hash for deduplication where privacy/ownership rules permit. Deduplication must never expose one tenant's asset to another tenant.

### `channel_media_cache`

Stores reusable remote channel media mappings:

- media asset
- channel account
- platform
- remote media/attachment ID
- validity/status
- uploaded/last-used/expiry timestamps
- failure metadata

If a remote ID fails, re-upload once under retry policy and replace the mapping.

## 9. AI configuration domain

### `ai_provider_connections`

- tenant/business scope as applicable
- provider type
- encrypted API key/secret
- base URL
- status/test metadata
- ownership mode (`BYOK`, `PLATFORM`)

### `ai_model_configs`

- provider connection
- config/task key
- model
- parameters JSONB
- limits
- active flag

Task-specific routing can cover default chat, image analysis, transcription, intent classification, prompt synthesis, embeddings, etc.

### `agent_profiles`

- tenant/business
- name
- description
- default collection/data links
- capabilities
- default AI model config
- behavior settings
- status

### `agent_channel_links`

Allows one agent to serve multiple channels and supports channel-specific overrides.

### `prompt_versions`

- agent profile
- version number
- source (`manual`, `training`, `template`, `migration`)
- prompt sections/content
- status (`draft`, `candidate`, `active`, `archived`)
- diff/base version metadata
- author/training job
- published_at

Only one active production prompt version per relevant scope unless an experiment/A-B system is intentionally introduced later.

## 10. Training domain

### `trainer_identities`

- tenant/business/channel scope
- type (`facebook_user`, `whatsapp_number`, `instagram_user`, `panel_simulator`, future)
- encrypted/normalized identifier as appropriate
- active flag

### `training_sessions`

Groups demonstrations and metadata for a training run.

### `training_examples`

Stores paired customer-like input, ideal owner response, attachments, context labels, and approval state.

### `training_jobs`

Tracks synthesis execution, input versions, model used, output candidate, cost, status, and errors.

Training data should never mutate the live prompt without a versioned publication decision.

## 11. Knowledge and vector tables

### `knowledge_sources`

Identifies source documents/entities.

### `knowledge_chunks`

- tenant/business/source
- chunk text/content
- source version
- metadata
- embedding vector
- embedding model/version
- active flag

Vectors must be invalidated/regenerated when source content changes materially.

## 12. Usage, billing readiness, and audit

### `usage_events`

Append-oriented event table for billable/operational units:

- event type
- quantity
- tenant/business/channel/conversation
- provider/model
- estimated/actual cost if available
- timestamp
- correlation IDs

### `usage_rollups`

Daily/hourly aggregates for dashboards and plan enforcement.

### `audit_logs`

Sensitive action history:

- actor user/admin/service
- tenant/business target
- action
- resource type/id
- before/after summary or safe diff
- IP/user agent/correlation IDs
- timestamp

Never put raw secrets in audit data.

## 13. Plan/limits tables

Suggested entities:

- `plans`
- `plan_features`
- `tenant_subscriptions`
- `tenant_limit_overrides`
- `channel_limit_overrides`

Even before payment integration, plan-aware feature/limit enforcement should be architecturally possible.

## 14. Event/outbox and job records

### `outbox_events`

Persist events in the same DB transaction as state changes. A dispatcher publishes them to queues/n8n and marks delivery state.

### `job_records` / external queue references

Durable application-visible status for important long-running jobs such as imports, training, embeddings, media processing, and bulk actions.

## 15. Indexing strategy

Minimum indexing families:

- tenant/business foreign-key paths
- `(channel_account_id, external_account_id)` identities
- unique inbound platform message keys
- conversation recency
- status + due timestamps for follow-ups/jobs
- collection + JSONB indexes for commonly searchable dynamic fields
- channel media cache lookups
- usage event time/routing fields
- vector indexes with tenant/business filtering strategy

Do not create every possible JSONB index. Promote/index fields based on actual query patterns.

## 16. Deletion and retention

Prefer explicit lifecycle states and controlled deletion. Define per-domain rules:

- Tenant deletion must be asynchronous, audited, and retention-aware.
- Historical order/booking records preserve snapshots.
- Deleted catalog items may be soft-deleted or hard-deleted according to retention rules, but transactional history remains valid.
- Conversation/media retention can be configurable by plan/legal policy.
- Secret records are revoked/rotated on disconnect.

## 17. Row-level security

PostgreSQL Row Level Security is recommended as defense-in-depth for tenant-scoped tables where compatible with the selected data-access architecture. Application authorization remains mandatory; RLS is not a substitute for correct API permissions.

## 18. Migration discipline

All schema changes use versioned database migrations. Production changes must avoid ad-hoc manual SQL. Migrations must include forward compatibility planning for workers/n8n during rolling deployment where applicable.