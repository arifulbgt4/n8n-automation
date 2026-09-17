# Migration from `n8n_local_envirnment`

## 1. Purpose

The repository `arifulbgt4/n8n_local_envirnment` is the previous spreadsheet-driven AI commerce/customer-support prototype. It contains valuable n8n behavior, database isolation ideas, Meta routing, human handoff, follow-up, screenshot/media logic, and dynamic AI configuration.

The target SaaS in this repository keeps those useful behaviors but replaces spreadsheet administration with first-class web applications and a central application database.

## 2. Legacy architecture summary

Legacy control flow:

```text
Control Spreadsheet
 -> PostgreSQL configuration
 -> per-account Operations Spreadsheets
 -> n8n runtime
 -> Facebook / Instagram / WhatsApp
```

Legacy database isolation already separated:

```text
n8n      -> n8n internal state
agent_app -> application/business data
```

The new system preserves the isolation principle but expands `agent_app` into the full SaaS `app_db`.

## 3. Behaviors to retain

### Multi-account routing

Legacy runtime selected the account using platform + external account identity. Preserve and generalize this for multi-tenant/multi-business routing.

### Dynamic per-account prompts/models

Legacy Control Spreadsheet provided account-scoped prompts and provider/model configs with task keys. Preserve the concept in database-backed agent/model configuration.

### Supported AI task ideas

Legacy tasks included:

- intent classification
- image/product analysis
- audio transcription
- product-search response
- order-details extraction
- general answering

Target system maps these to general task-specific model routing and capabilities.

### Human control

Legacy `HumanSupportQueue`/mode behavior disabled AI in HUMAN mode and allowed resumption. Preserve as DB-backed conversation mode + Customer Panel inbox controls.

### Facebook echo protection

Legacy compared Facebook message echoes with bot outbound records to avoid interpreting its own bot reply as a human Page-owner reply. Preserve this logic in normalized message delivery records.

### Follow-up guards

Legacy blocked follow-ups in HUMAN mode and checked runtime conditions. Preserve and expand with plan/rate/provider-window/tenant-active guards.

### Screenshot/product lookup

Legacy used configured vision AI on an inbound screenshot, converted analysis into a catalog search, and grounded response in PostgreSQL products. Preserve as generic multimodal analysis + attached dynamic collection search.

### Multiple product images

Legacy supported up to several ordered media records and sent requested images in batches/loops. Preserve as generic media gallery + response-plan limits.

### Reusable Facebook attachment IDs

Legacy cached Facebook `attachment_id` after first successful upload and reused it. Preserve and generalize as `channel_media_cache` for all supported providers.

### Modular workflows

Legacy V4.2 split the earlier 170+ node monolith into smaller workflows. Continue modular architecture; do not rebuild one giant workflow.

### Health checks

Preserve system/channel/configuration health concepts and expose them through Super Admin.

## 4. Components to remove from target runtime

The following legacy components are explicitly replaced:

- `Control Spreadsheet` as source of configuration.
- `Operations Spreadsheet` as catalog/order/support UI.
- Spreadsheet-to-PostgreSQL synchronization workflows.
- Spreadsheet-stored Meta tokens/secrets.
- Spreadsheet-stored AI API keys.
- Spreadsheet prompt registry.
- Spreadsheet AI model registry.
- Google Apps Script media synchronization.
- Fixed merchant-facing Products sheet schema.
- Manual spreadsheet IDs in account configuration.

The new Customer Panel and Super Admin Panel perform all administration.

## 5. Legacy field mapping

### Legacy Businesses

```text
Business Key
Business Name
Delivery Charge
Payment Methods
Active
```

Target mapping:

- `businesses`
- typed/default business settings
- capability-specific delivery/payment configuration

### Legacy Accounts

Legacy fields such as platform, Page ID, Instagram ID, WhatsApp phone number ID, tokens, reply URL, rate limits, follow-up settings map to:

- `channel_accounts`
- encrypted `channel_credentials`
- channel settings/limits
- follow-up policies
- provider adapter configuration

### Legacy AI prompts/models

Maps to:

- `agent_profiles`
- `prompt_versions`
- `ai_provider_connections`
- `ai_model_configs`

### Legacy Products/FAQ

Maps to:

- dynamic `collections`
- `collection_fields`
- `collection_items`
- media assets
- knowledge sources/vector index where appropriate

### Legacy Orders

Maps to first-class `orders` + `order_items` with channel/conversation attribution.

### Legacy HumanSupportQueue/Latest

Maps to:

- conversations
- mode/state
- assignments
- messages
- audit events

## 6. Migration strategy

Do not directly port all old workflow JSON and then retrofit the SaaS around it. Instead:

1. Implement the new application/domain foundation.
2. Create stable internal API/event contracts.
3. Rebuild n8n modular workflows against those contracts.
4. Use legacy workflows as behavioral/reference tests.
5. Migrate useful logic one subsystem at a time.
6. Remove spreadsheet dependencies completely before production SaaS launch.

## 7. Suggested legacy-to-new workflow mapping

```text
Legacy setup/control sync
    -> removed; Customer/Super Admin + app_db

Legacy operations spreadsheet init
    -> removed; dynamic data UI/database

Legacy catalog sync
    -> replaced by direct app CRUD/import jobs

Legacy human control sync
    -> Customer Panel conversation mode/actions

Legacy follow-up workflow
    -> new follow-up queue/n8n orchestration

Legacy Meta messaging
    -> new normalized webhook + conversation + agent + delivery architecture
```

## 8. Data migration from an existing legacy deployment

If actual production-like data from `agent_app` must be imported later, create explicit import scripts/jobs for:

- businesses
- accounts
- products/variants/media
- FAQ/knowledge
- conversation/handoff state where useful
- orders
- prompts/model configs

Do not import old plaintext spreadsheet secrets blindly. Reconnect/rotate sensitive channel/provider credentials through the new secure credential flow where possible.

## 9. Product schema migration

Legacy product-specific columns become dynamic collection fields. A migration can create a `Products` collection template and map known columns:

- Product Name
- Price
- Description
- Stock Status/Qty
- Category/Subcategory
- Color/Size
- SKU
- Offer/Discount
- Aliases
- images

Unknown legacy attributes can be imported into explicit custom fields or a reviewed attributes object. New system does not require category/price fields for every collection.

## 10. Media migration

Legacy cached local product media/Drive URLs/Facebook attachment IDs must not remain tied to old storage assumptions.

Target migration:

1. Import source media into OpenMusk media storage where needed.
2. Create `media_assets` with content hashes.
3. Link to collection items.
4. Optionally migrate known valid channel remote media IDs into `channel_media_cache` with validation/stale fallback.

## 11. Regression comparison

Before declaring migration complete, run scenarios against both expected legacy behavior and new implementation:

- simple product/service question
- screenshot lookup
- multi-image request
- order creation
- HUMAN takeover/resume
- Facebook Page-owner manual reply echo behavior
- follow-up suppression in HUMAN mode
- channel/account routing
- task-specific model selection
- missing configuration failure

## 12. Cutover rule

Once the SaaS environment for a tenant/account is active, do not run the old spreadsheet-driven workflows in parallel on the same production channel. Duplicate webhooks/schedules can generate duplicate replies and actions.

Cutover procedure should:

- pause legacy workflow
- verify new webhook/subscription
- verify new channel credentials
- run health test
- enable new runtime
- monitor first real conversations
- keep rollback plan for a bounded period without dual-active message processing

## 13. Legacy repository status

Treat `n8n_local_envirnment` as a reference/archival implementation. New features should be designed and documented in `n8n-automation` first rather than extending the spreadsheet architecture unless a specific maintenance need requires it.