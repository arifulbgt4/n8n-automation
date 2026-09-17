# Domain and database specification

## 1. Database choice

PostgreSQL is the primary database. The application uses relational tables for identities, ownership, transactions, and relationships; JSONB for tenant-defined flexible fields/configuration; and pgvector for embeddings.

The SaaS database is referred to as `app_db`. The n8n internal database remains separate. The PostgreSQL service itself is pre-provisioned infrastructure; this repository owns only the application schema/migrations and application credentials.

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
  +-- Media Assets
```

Every tenant-owned table must have a clear path to `tenant_id`. Where practical, high-volume tables should carry `tenant_id` directly even if it can be derived through joins.

## 3. Core identity and tenancy tables

### `users`

- `id` UUID
- `email` normalized unique
- `password_hash` or external auth subject
- `email_verified_at`
- `status` (`active`, `invited`, `suspended`, `disabled`)
- `name`
- `last_login_at`
- `created_at`, `updated_at`

### `tenants`

- `id`
- `name`
- `slug`
- `status`
- `plan_id` nullable
- `settings_json`
- timestamps

### `tenant_memberships`

- `tenant_id`
- `user_id`
- `role`
- `status`
- invitation metadata
- timestamps

Initial roles: `OWNER`, `ADMIN`, `STAFF`, `VIEWER`.

### `platform_admins`

Super-admin access is separated from tenant membership. Do not represent super-admin capability by placing a special tenant role on a normal tenant membership.

## 4. Business and channel tables

### `businesses`

- `id`
- `tenant_id`
- `name`
- `business_type_hint` nullable; informational only
- locale/timezone/currency defaults
- status
- settings JSONB
- timestamps

### `channel_accounts`

One connected endpoint: Facebook Page, Instagram professional account, WhatsApp business number, or a future channel.

- `id`
- `tenant_id`
- `business_id`
- `platform`
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

Credentials may be modeled separately from `channel_accounts` to isolate encryption/rotation metadata. Never store secrets in logs or expose them to browsers.

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

Initial field types:

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

### `collection_item_media`

Links collection items to durable media assets with ordering and role (`primary`, `gallery`, `document`, etc.).

### `collection_channel_links`

Many-to-many mapping from a collection to channel accounts. This enables one catalog/service list to serve Facebook + WhatsApp + Instagram simultaneously, or different datasets per channel.

### `collection_item_channel_overrides`

Optional channel-specific overrides such as active/hidden, channel price, channel alias, or channel-specific copy. Base data remains shared.

## 6. Transactional action model

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
- source collection/item ID nullable
- title/SKU/variant snapshot
- quantity
- unit price/totals
- item attributes snapshot

Historical orders preserve what was purchased even if current catalog data changes.

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

Use dedicated tables when the feature becomes first-class. Avoid forcing every business action into opaque JSON if the UI/reporting needs strong semantics.

## 7. Conversation domain

### `contacts`

A platform/customer identity resolved within a tenant/business/channel context. Do not assume the same human can always be merged across Facebook, Instagram, and WhatsApp.

### `conversations`

- tenant/business/channel account/contact
- mode (`AI`, `HUMAN`, optionally `PAUSED`)
- status
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

Groups one or more transport messages into a logical AI/human turn.

### `message_media`

Links messages to `media_assets`.

## 8. Media domain

The existing Media Storage service owns the physical bytes and storage-level user/quota metadata. `app_db` owns SaaS tenant/business authorization, semantic relationships, and provider-delivery mappings.

### `tenant_media_accounts`

Preferred model: one Media Storage user/account per SaaS tenant.

Suggested fields:

- `id`
- `tenant_id` unique active mapping
- `storage_provider`
- `external_user_id`
- encrypted media API credential or secure credential reference
- `status`
- optional quota/usage snapshot
- `last_health_checked_at`
- timestamps

Customer/browser code must never receive the Media Storage bearer key.

### `media_assets`

- `id`
- `tenant_id`
- `business_id` nullable when tenant-global
- `tenant_media_account_id`
- `storage_provider`
- `storage_file_id` external Media Storage file UUID
- `storage_user_id` external user UUID where useful
- `original_name`
- `mime_type`
- `kind`
- `visibility` (`private`, `public`)
- `size_bytes`
- `content_hash` / SHA-256 checksum
- `public_url` nullable; treated as a delivery descriptor, not authorization source
- width/height/duration where derived
- source/type
- processing status
- timestamps

The Media Storage service returns a service-relative authenticated content path. Do not store a hard-coded infrastructure base URL in every asset; the storage adapter resolves it from deployment configuration.

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

Training data never mutates the live prompt without a versioned publication decision.

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

Append-oriented units:

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

- actor user/admin/service
- tenant/business target
- action
- resource type/id
- safe before/after summary
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

Plan limits include message, AI, media, queue/concurrency, and storage quotas where applicable.

## 14. Event/outbox and job records

### `outbox_events`

Persist events in the same DB transaction as state changes. A dispatcher publishes them to queues/n8n and marks delivery state.

### `job_records`

Application-visible status for important long-running jobs such as imports, training, embeddings, media processing, and bulk actions.

### `automation_deployments`

Recommended deployment metadata for n8n workflow bundles:

- environment
- bundle version
- workflow key
- n8n workflow ID
- logical workflow version
- active status
- deployed_at/deployed_by
- previous deployment reference
- health/last-seen metadata

This lets Super Admin diagnose expected vs deployed workflow versions without storing workflow definitions in `app_db`.

## 15. Indexing strategy

Minimum indexing families:

- tenant/business foreign-key paths
- `(channel_account_id, external_account_id)` identities
- unique inbound platform message keys
- conversation recency
- status + due timestamps for follow-ups/jobs
- collection + JSONB indexes for commonly searchable dynamic fields
- media asset storage IDs/checksums
- channel media cache lookups
- usage event time/routing fields
- vector indexes with tenant/business filtering strategy

Do not create every possible JSONB index. Promote/index fields based on actual query patterns.

## 16. Deletion and retention

- Tenant deletion is asynchronous, audited, and retention-aware.
- Historical order/booking records preserve snapshots.
- Deleted catalog items may be soft/hard-deleted according to policy while transactional history remains valid.
- Conversation/media retention can be configurable by plan/legal policy.
- Secret records are revoked/rotated on disconnect.
- Media deletion must be reference-aware; deleting a local media asset does not automatically remove copies already uploaded to external providers.
- Tenant deletion must also revoke/delete the corresponding Media Storage user/files according to approved retention policy.

## 17. Row-level security

PostgreSQL Row Level Security is recommended as defense-in-depth for tenant-scoped tables where compatible with the selected data-access architecture. Application authorization remains mandatory.

## 18. Migration discipline

All schema changes use versioned database migrations. Production changes must avoid ad-hoc manual SQL. Migrations must include forward compatibility planning for workers/n8n workflow bundles during rolling deployment where applicable.