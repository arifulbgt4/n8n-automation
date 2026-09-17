# Existing infrastructure integration and n8n workflow delivery

## 1. Scope

The SaaS application is built on infrastructure that is already provisioned and operated separately from this repository. This repository must consume those services through stable configuration and API contracts; it must not duplicate their installation or administration.

Already-running infrastructure includes:

- PostgreSQL service/cluster.
- Redis service.
- n8n runtime and its own internal database/runtime configuration.
- Multi-user Media Storage service.
- Reverse proxy/TLS and host-level service management.

This document defines how the application integrates with those services and how the n8n automation JSON files produced by this project are versioned, imported, updated, tested, activated, and rolled back.

Infrastructure repository names, admin-panel URLs, public hostnames, ports, and secrets are deliberately not part of this application contract. They are environment/deployment configuration.

## 2. Responsibility boundary

### This repository owns

- Customer Panel.
- Super Admin Panel.
- SaaS backend/API.
- `app_db` schema and migrations.
- worker code and queue contracts.
- Redis key/job namespaces used by this SaaS.
- Media Storage adapter/client behavior.
- media metadata and tenant ownership in `app_db`.
- n8n workflow definitions/exports for this SaaS.
- n8n workflow bundle version/manifest.
- API/event contracts consumed by n8n.
- application observability and acceptance tests.

### Existing infrastructure owns

- installing/upgrading the PostgreSQL server itself.
- installing/upgrading Redis itself.
- installing/upgrading n8n itself.
- n8n process topology/queue mode and host-level configuration.
- installing/upgrading the Media Storage service itself.
- reverse proxy/TLS and host networking.
- host backups/volumes/service supervision at the infrastructure layer.

Application implementation must never assume it can reconfigure infrastructure merely by deploying this repository.

## 3. Environment configuration rule

All infrastructure connection details are injected by deployment secrets/environment configuration.

Conceptual application variables:

```text
DATABASE_URL
REDIS_URL
MEDIA_BASE_URL
MEDIA_API_KEY or media credential reference
INTERNAL_SERVICE_AUTH_SECRET
N8N_WORKFLOW_BUNDLE_VERSION
```

Exact secret names may change during implementation, but these principles are mandatory:

- no real endpoint or credential is committed to Git.
- browser code never receives database/Redis/media-service/n8n administrative credentials.
- environment-specific hostnames are not embedded in workflow JSON or application source when a variable/service setting can be used.
- development/staging/production use separate credentials and isolated data.

## 4. PostgreSQL integration

The PostgreSQL service already exists. The application is responsible for creating and migrating its SaaS database/schema through the selected migration system.

`app_db` remains the source of truth for SaaS business state.

The n8n internal database remains independent. There is no database synchronization process between the two.

Application deployment tasks are therefore:

1. verify database connectivity with the application credential.
2. verify required extensions, including pgvector when introduced.
3. run versioned application migrations.
4. run migration/health checks.
5. deploy API/workers compatible with the resulting schema.

Do not add PostgreSQL installation scripts merely because the application needs database access.

## 5. Redis integration

Redis already exists. This repository configures a client and uses explicit namespaces.

Redis is used for:

- queue backend/coordination.
- rate limiting.
- distributed locks.
- conversation aggregation windows.
- short-lived deduplication/idempotency helpers.
- hot configuration caches.
- temporary runtime state that is reconstructable from durable sources.

Redis is not the durable source of truth.

Every application-owned key must be namespaced so it cannot collide with another deployed system. A conceptual prefix is:

```text
n8nauto:{environment}:{purpose}:...
```

The final prefix is configuration, not hard-coded infrastructure identity.

No infrastructure task in the application roadmap should say “install Redis” or “create Redis server.” Tasks should say “configure Redis client,” “define queue namespace,” “implement limiter,” etc.

## 6. Media Storage service contract

The existing Media Storage service is a production-oriented multi-user file store. Physical bytes are stored by the media service; ownership/quota/file metadata are managed by that service. The SaaS also stores its own tenant-facing media metadata and relationships in `app_db`.

The Media Storage service supports:

- independent media users.
- bearer API keys per media user.
- optional per-user storage quotas.
- private and public files.
- authenticated binary download.
- optional public file URLs.
- hard file deletion.
- MIME/extension validation.
- UUID storage identities.
- SHA-256 checksum metadata.
- storage/quota accounting.

The SaaS must consume the user API, not the infrastructure admin UI.

## 7. Media user mapping

Preferred isolation model:

```text
SaaS tenant
    -> one Media Storage user/account
    -> one server-side Media API credential
```

This gives storage-level separation and allows plan/tenant quota mapping.

Store the relationship in application data, conceptually:

### `tenant_media_accounts`

- `id`
- `tenant_id` unique active mapping
- external media user ID
- encrypted/referenced API credential
- status
- quota snapshot if useful
- last health check
- created/updated timestamps

The credential is never returned to customer browser code.

A single shared platform media account may be used only as an explicitly approved temporary implementation, because it weakens infrastructure-level tenant isolation. The target design is tenant-scoped media users.

## 8. Media API calls used by the SaaS

Authenticated user requests use a server-side bearer token.

Required operations are:

```text
GET    /api/v1/storage
POST   /api/v1/files
GET    /api/v1/files?limit=<n>&offset=<n>
GET    /api/v1/files/:id
GET    /api/v1/files/:id/content
PATCH  /api/v1/files/:id
DELETE /api/v1/files/:id
```

Upload is multipart form data:

```text
file        required
visibility  optional: private | public
```

The storage adapter must wrap these endpoints. Other application modules must call the adapter instead of constructing Media Storage URLs themselves.

## 9. Media file metadata mapping

The Media Storage service returns file metadata including fields equivalent to:

```text
id
user_id
original_name
mime_type
extension
size_bytes
kind
visibility
checksum_sha256
public_url (nullable)
content_url
created_at
```

Map these into `app_db.media_assets` without duplicating the binary.

Recommended application fields include:

```text
media_assets.id                 internal SaaS UUID
media_assets.tenant_id
media_assets.business_id        nullable
media_assets.storage_provider   existing_media_service
media_assets.storage_file_id    external file UUID
media_assets.storage_user_id    external media user UUID
media_assets.original_name
media_assets.mime_type
media_assets.size_bytes
media_assets.kind
media_assets.visibility
media_assets.content_hash       service checksum
media_assets.public_url         nullable/cacheable descriptor
media_assets.processing_status
media_assets.created_at
```

The external `content_url` is a service-relative path and should be resolved only by the storage adapter using the configured service base URL.

## 10. Private vs public media

Default to `private` for:

- inbound conversation screenshots.
- customer-uploaded private documents.
- training attachments.
- internal evidence/support files.

Use `public` only when a provider must fetch the asset over HTTPS and the business/policy permits public access, such as approved product/service catalog images.

If public serving is not appropriate, the delivery worker/n8n fetches authenticated binary content and uploads it directly to the channel provider.

Public URLs must not replace application authorization. The SaaS still records tenant ownership and allowed use.

## 11. Media upload flow

Canonical application upload:

```text
Browser
 -> SaaS API authorization
 -> validate tenant/business intent
 -> server-side multipart request to Media Storage
 -> receive storage metadata/checksum
 -> create media_assets row
 -> create collection/message/training relationship
 -> return SaaS media object to browser
```

The browser must not receive the Media Storage bearer key.

For large uploads, streaming should be used where supported so the application does not load the full binary into memory.

## 12. Inbound channel media flow

```text
Meta inbound media reference
 -> normalized message persisted
 -> media-ingestion job
 -> authenticated/provider download
 -> upload to Media Storage as private by default
 -> media_assets row
 -> message_media link
 -> optional vision/transcription processing
```

Persist the platform source ID separately for traceability and idempotency.

## 13. n8n access to media

When a workflow needs binary media, it should receive an internal `media_asset_id` or an authorized resolved descriptor rather than arbitrary filesystem paths.

Preferred patterns:

1. n8n calls the SaaS internal media endpoint, which validates and proxies/resolves the asset; or
2. an approved n8n workflow uses the Media Storage user API with a server-side bearer credential and fetches `/api/v1/files/:id/content` as binary.

Do not place Media Storage admin credentials in n8n workflows.

## 14. Meta/channel media reuse

Media Storage is the canonical binary source. Provider-specific reusable media IDs are a separate cache:

```text
media_asset
 -> channel_media_cache
    -> Facebook attachment ID / WhatsApp media ID / equivalent
```

Delivery algorithm:

1. resolve media asset.
2. look for a valid remote media mapping for the target channel account.
3. reuse it when supported.
4. on stale/invalid provider ID, lock refresh for `(asset, channel_account)`.
5. fetch binary or approved public URL from Media Storage.
6. upload once to provider.
7. persist new remote media ID.
8. send message.
9. meter cache hit/miss/re-upload.

Deleting the local Media Storage file does not automatically delete copies previously uploaded to external channel providers; provider cleanup is a separate lifecycle concern.

## 15. Media deletion and quota behavior

Application deletion is reference-aware.

```text
request delete
 -> verify tenant authorization
 -> check durable references
 -> mark pending deletion / grace period when required
 -> delete external media file
 -> update/remove media_assets metadata
 -> emit audit/usage events
```

The Media Storage service enforces user quotas and host reserve rules. The SaaS should surface quota errors as structured customer/admin errors instead of retrying indefinitely.

Tenant plan quota and Media Storage user quota should be reconciled so application limits do not promise more than infrastructure allows.

## 16. Media backup implication

A recoverable media deployment requires both:

- Media Storage metadata/database backup.
- physical Media Storage file-tree backup.

The SaaS `app_db` backup alone is not sufficient because it contains references, not binary files.

## 17. n8n workflow artifacts

The existing n8n runtime will execute project workflows. This repository owns the workflow definitions as version-controlled JSON artifacts.

Planned repository layout during implementation:

```text
automation/
  n8n/
    manifest.json
    workflows/
      01_meta_webhook_gateway.json
      02_inbound_conversation.json
      03_agent_runtime.json
      04_multimodal.json
      05_training_pipeline.json
      06_followups.json
      07_health_maintenance.json
    README.md
```

The exact split may change, but a giant single workflow is not the target.

## 18. Workflow manifest

`manifest.json` should define at least:

```json
{
  "bundleVersion": "1.0.0",
  "minimumN8nVersion": "<validated version/range>",
  "workflows": [
    {
      "key": "meta-webhook-gateway",
      "file": "workflows/01_meta_webhook_gateway.json",
      "required": true,
      "activation": "webhook"
    }
  ]
}
```

Optional fields:

- description.
- logical workflow version.
- required internal API contract version.
- required environment/config keys.
- required credential aliases.
- migration notes.
- checksum generated by deployment tooling.

The manifest describes application-owned workflows; it does not manage the n8n installation.

## 19. Workflow export rules

After a workflow is created/tested in a development/staging n8n instance:

1. export the workflow JSON.
2. remove or verify absence of secrets.
3. remove environment-specific hostnames where configuration can be used.
4. verify no customer access tokens/API keys are embedded.
5. minimize environment-specific credential IDs.
6. keep stable workflow/node names so diagnostics remain understandable.
7. ensure workflow is inactive in the committed artifact unless the deployment process deliberately controls activation separately.
8. validate JSON.
9. update manifest bundle/workflow version.
10. commit JSON + documentation/contracts together.

Never commit n8n credential exports or encrypted credential database content as workflow artifacts.

## 20. Credential strategy for workflow portability

Workflows should require only a small set of platform/internal credentials.

Customer-specific Meta and AI secrets remain encrypted in the SaaS application and are resolved at runtime through approved service calls. Do not create one static n8n credential for every tenant.

Typical environment-scoped n8n configuration may include:

- internal SaaS API service credential.
- platform-level integration credential where truly global.
- Media Storage user credential only if direct n8n media access is approved; otherwise use internal SaaS API.

Credential IDs differ by n8n instance. Therefore committed workflow JSON must not rely on an opaque production credential ID as its only portable identity.

## 21. Initial manual workflow import

For first deployment or controlled updates:

1. open the existing n8n instance.
2. keep the currently active production workflow bundle unchanged.
3. import each JSON file from the versioned bundle using n8n's workflow import-from-file capability.
4. keep imported workflows inactive.
5. bind required environment-specific credentials/configuration.
6. verify webhook paths do not conflict with the active bundle.
7. run manual/test triggers where applicable.
8. execute health and end-to-end staging tests.
9. record imported workflow IDs and bundle version in platform deployment metadata.
10. switch activation according to the cutover plan.

Do not activate duplicate webhook/scheduled workflows before the previous active bundle is deactivated or migrated.

## 22. Workflow update strategy

Importing a JSON file can create a new workflow rather than safely replacing an existing one depending on the chosen n8n operation/version. Therefore updates must use an explicit deployment strategy.

Supported strategies:

### Blue/green workflow bundle

Preferred for major changes:

```text
current bundle A active
 -> import bundle B inactive
 -> configure/test B
 -> deactivate conflicting triggers in A
 -> activate B
 -> monitor
 -> archive A after rollback window
```

### In-place controlled update

Allowed for small changes when the deployment tool can reliably address the intended workflow by stable deployment metadata/ID. Export/backup the current version first.

Never identify the production workflow only by a human-readable name when an immutable deployment record can be used.

## 23. Automated workflow deployment later

After manual deployment is stable, build a deployment script/service using the API/CLI supported by the pinned n8n version.

The automation should:

- read `manifest.json`.
- validate n8n compatibility.
- validate required configuration/credential aliases.
- create/update target workflows deterministically.
- leave trigger activation under explicit deployment control.
- record workflow IDs, bundle version, deployment timestamp, and result.
- support dry-run/diff where possible.
- fail safely without partially activating conflicting webhook versions.

The exact n8n API route must be implemented against the version actually deployed; it is not hard-coded in this architecture document.

## 24. Workflow activation/cutover

Before activation:

- internal SaaS API reachable.
- app database migrations compatible.
- Redis/queue reachable.
- Media Storage path tested when workflows use media.
- Meta webhook credentials/config correct.
- AI runtime configuration present for test tenant.
- duplicate webhook/schedule conflicts eliminated.
- required workflows report the expected bundle version.

Cutover should be atomic enough that one inbound provider event is not processed by two production bundles.

## 25. Workflow rollback

Keep the previous bundle available during a bounded rollback period.

Rollback sequence:

1. stop/deactivate new conflicting triggers.
2. restore previous compatible workflow bundle.
3. verify API/database schema compatibility.
4. reactivate previous triggers.
5. verify provider webhook health.
6. record rollback reason and deployment state.

Do not roll back a workflow to a version incompatible with current application API/database contracts.

## 26. Workflow version visibility

Super Admin should eventually show:

- expected workflow bundle version.
- deployed workflow bundle version.
- required workflows present/missing.
- active/inactive state.
- last health/heartbeat.
- recent execution failures.
- deployment timestamp.

This is monitoring/metadata only. Super Admin does not need to become a replacement n8n editor.

## 27. Acceptance criteria

Existing infrastructure integration is accepted when:

- application deployment does not attempt to install Redis, n8n, or Media Storage.
- no infrastructure admin URL/repository path is required in application code or canonical docs.
- Media Storage API key remains server-side.
- a tenant's media is storage-isolated according to the approved media-user mapping.
- media upload/download/delete works through the adapter.
- private and public media policies are enforced.
- n8n can retrieve required media without admin credentials.
- n8n workflow JSON is reproducible from Git and contains no secrets.
- a fresh imported workflow bundle can be configured/tested while inactive.
- bundle activation cannot accidentally duplicate webhook/schedule processing.
- deployment records make rollback and workflow version diagnosis possible.