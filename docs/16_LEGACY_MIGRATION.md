# Behavioral migration from the earlier prototype

## 1. Purpose

The earlier spreadsheet-driven AI commerce/customer-support prototype proved useful runtime behaviors: Meta routing, human handoff, follow-up guards, screenshot/media handling, reusable provider media IDs, task-specific AI configuration, and modular n8n automation.

The target SaaS keeps those behaviors but does not depend on the earlier repository, spreadsheet control plane, local media-cache implementation, or infrastructure layout.

## 2. Earlier architecture summary

```text
Control Spreadsheet
 -> PostgreSQL configuration
 -> per-account Operations Spreadsheets
 -> n8n runtime
 -> Facebook / Instagram / WhatsApp
```

The new architecture replaces spreadsheet administration with:

```text
Customer/Super Admin Panels
 -> SaaS API
 -> app_db
 -> queues/workers/n8n workflow bundle
 -> Facebook / Instagram / WhatsApp
```

## 3. Behaviors to retain

### Multi-account routing

Resolve runtime account using platform + receiving external account identity and generalize this to tenant/business/channel routing.

### Dynamic per-account prompts/models

Preserve account/business-scoped prompts and task-specific provider/model selection as database-backed agent/model configuration.

### AI task concepts

Retain/generalize:

- intent classification.
- image analysis.
- audio transcription.
- data/catalog response.
- structured order/booking extraction.
- general answering.

### Human control

Preserve HUMAN/AI conversation mode and operator resume/takeover behavior through `app_db` and Customer Panel controls.

### Facebook echo protection

Compare Page-owner/provider echo events with durable bot outbound provider message IDs so bot echoes do not falsely trigger HUMAN takeover.

### Follow-up guards

Preserve HUMAN-mode suppression and expand with tenant/channel active state, provider policy windows, plan/rate limits, and idempotency.

### Screenshot lookup

Preserve the pattern:

```text
inbound screenshot
 -> vision analysis
 -> structured search hints
 -> current business data lookup
 -> grounded response
```

### Multiple images

Preserve bounded multi-image responses, but use generic Media Storage + provider-neutral response plans instead of product-sheet assumptions.

### Reusable Facebook attachment IDs

Preserve and generalize as `channel_media_cache` for all supported providers.

### Modular workflows

Continue modular workflow JSON rather than rebuilding one giant monolith.

### Health checks

Preserve channel/config/runtime health concepts and expose them through Super Admin.

## 4. Components removed from target runtime

The following are explicitly not carried forward:

- Control Spreadsheet as configuration source.
- Operations Spreadsheet as catalog/order/support UI.
- spreadsheet-to-PostgreSQL synchronization workflows.
- spreadsheet-stored Meta tokens/secrets.
- spreadsheet-stored AI API keys.
- spreadsheet prompt/model registries.
- Google Apps Script media synchronization.
- fixed product-sheet schema.
- spreadsheet IDs in channel configuration.
- local workflow-specific filesystem media cache as canonical media storage.
- infrastructure installation/setup logic inside this application repository.

## 5. Legacy concept mapping

### Business configuration

Maps to:

- `businesses`.
- business settings.
- capabilities.
- dynamic collections.

### Channel/account configuration

Maps to:

- `channel_accounts`.
- encrypted `channel_credentials`.
- channel settings/limits.
- follow-up policies.

### AI prompts/models

Maps to:

- `agent_profiles`.
- `prompt_versions`.
- `ai_provider_connections`.
- `ai_model_configs`.

### Products/FAQ

Maps to:

- `collections`.
- `collection_fields`.
- `collection_items`.
- `media_assets`.
- knowledge/vector sources where appropriate.

### Orders

Maps to first-class `orders` + `order_items` with source channel/conversation attribution.

### Human support queue/state

Maps to conversations, mode/state, assignments, messages, and audit events.

## 6. Migration strategy

Do not import an old monolithic/legacy workflow set and retrofit the SaaS around it.

Instead:

1. implement application/domain foundations.
2. create stable internal API/event contracts.
3. implement Media Storage/Redis/queue integration.
4. rebuild modular n8n workflows against the new contracts.
5. use expected legacy behavior as regression scenarios.
6. remove spreadsheet dependencies before SaaS launch.

## 7. New workflow mapping

```text
old setup/control sync
 -> removed; Customer/Super Admin + app_db

old operations-sheet initialization
 -> removed; dynamic data UI/database

old catalog sync
 -> direct app CRUD/import jobs

old human-control sync
 -> Customer Panel conversation mode/actions

old follow-up workflow
 -> follow-up queue + modular n8n orchestration

old Meta messaging
 -> normalized webhook + conversation + agent + delivery architecture
```

## 8. Optional data migration

If historical prototype data is imported later, create explicit one-time import jobs/scripts for:

- businesses.
- accounts/channels.
- products/variants/media.
- FAQ/knowledge.
- conversation/handoff state where useful.
- orders.
- prompts/model configs.

Do not blindly import plaintext legacy secrets. Reconnect/rotate channel/provider credentials through the new secure flow where possible.

## 9. Product schema migration

Product-specific columns become dynamic collection fields. A migration can create a `Products` template and map known attributes such as name, price, description, stock, category, color/size, SKU, offer/discount, aliases, and images.

Unknown attributes become reviewed custom fields or structured data. New collections do not require category/price fields.

## 10. Media migration

Old source URLs/local caches/remote attachment IDs must be detached from old storage assumptions.

Target migration:

1. ingest required source binaries into the existing Media Storage service.
2. create `media_assets` with external storage file IDs and checksums.
3. link assets to collection items/messages as appropriate.
4. optionally import known provider remote media IDs into `channel_media_cache` only when still valid or safely recoverable.
5. rely on stale-ID fallback/re-upload for provider cache recovery.

## 11. Regression comparison

Before migration is complete, test:

- simple product/service question.
- screenshot lookup.
- multi-image request.
- order creation.
- HUMAN takeover/resume.
- Facebook Page-owner manual reply echo behavior.
- follow-up suppression in HUMAN mode.
- multi-business/channel routing.
- task-specific model selection.
- missing configuration failure.
- Media Storage private binary retrieval.
- remote media cache reuse/fallback.

## 12. Cutover rule

Do not run old and new message-processing workflows simultaneously on the same production channel.

Cutover:

- deactivate conflicting old triggers.
- import/configure new workflow bundle while inactive.
- verify webhook/subscription/credentials.
- run health test.
- activate new bundle.
- monitor first real conversations.
- retain bounded rollback ability without dual-active processing.

## 13. Reference independence

The new SaaS documentation and runtime must be self-contained. Earlier repositories may be inspected during development to understand prior behavior, but production code/documentation must not require their repository URLs, admin URLs, spreadsheet IDs, or infrastructure layout.