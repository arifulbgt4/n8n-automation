# Customer Panel specification

## 1. Purpose

`customer-panel` is the tenant-facing SaaS application. It is the primary place where customers sign up, configure businesses/channels, manage data, train AI agents, operate conversations/transactions, inspect usage, and control automation behavior.

The UI hides infrastructure complexity such as raw n8n workflow IDs, Redis keys, queue internals, database structure, Media Storage credentials, and host/admin endpoints.

## 2. Primary navigation

Proposed top-level navigation:

- Dashboard
- Businesses
- Channels
- Data / Catalogs
- Conversations
- Orders / Business Actions
- AI Agents
- Training
- Knowledge
- Media
- Analytics / Usage
- Team
- Settings
- Plan / Billing (when enabled)

Navigation adapts to enabled capabilities. A service business may emphasize Bookings instead of Orders.

## 3. Onboarding flow

1. Sign up.
2. Verify email.
3. Create tenant/organization.
4. Create first business.
5. Choose optional use-case hint/template.
6. Connect Facebook/Instagram/WhatsApp or skip.
7. Create/import first data collection or choose template.
8. Create/select an AI agent template.
9. Configure platform AI or BYOK provider.
10. Test in simulator.
11. Publish/activate automation.

Onboarding preserves progress.

## 4. Dashboard

Show actionable state:

- connected channels/health.
- messages today/7/30 days.
- open AI/HUMAN conversations.
- failed deliveries/reconnect-required channels.
- AI turns/tokens/cost estimate.
- orders/bookings/leads by channel.
- conversion summaries.
- relevant queue/backlog warnings.
- training candidates awaiting review.
- usage vs plan limits.
- media storage usage/quota where plan exposes it.

Filters: business, channel, date range.

## 5. Businesses

Customers can:

- create multiple businesses.
- rename/archive businesses.
- configure timezone, currency, language/locale, contact information, delivery/payment defaults, and general settings.
- assign team members to businesses.
- set default AI agent/model/data/limits.
- view connected channels.

Destructive operations require confirmation and retention/history rules.

## 6. Channel management

### Channel list

Display platform/account, connection status, last activity, business, assigned/shared collections, agent, limits, and reconnect warnings.

### Connect channel

Customer can connect:

- Facebook Page(s).
- Instagram professional account(s).
- WhatsApp Business account/phone number(s).

### Channel detail

Configure:

- display name.
- active/paused state.
- default agent.
- attached collections.
- channel-specific behavior override.
- channel-specific limits below ceilings.
- follow-up policy.
- human handoff behavior.
- trainer identities.
- media send preferences.
- connection/test status.

## 7. Dynamic Data / Catalog builder

Customers are not limited to Products.

### Collection templates

- Products
- Services
- Properties
- Menu
- Packages
- Courses
- FAQ-like structured list
- Blank custom collection

### Field builder

Allowed fields include text, long text, number/decimal, currency, boolean, date/date-time, email/phone/URL, single-select, multi-select, image/media, and relation/reference.

Configure label, key, type, required, AI visibility, search/filter/sort behavior, options, and validation.

These are application schema definitions, not raw SQL columns.

### Table/data editor

Customers can add/edit/delete/archive items, bulk edit where safe, search/filter/sort, upload one/many files, reorder gallery media, import/export in later phases, and view validation errors.

### Channel linking

A collection can link to one or many channels; customer sees where changes take effect.

### Overrides

Where enabled, a channel may override selected fields such as visibility/price while base data remains shared.

## 8. Conversations / Inbox

Unified inbox features:

- filter by business/channel/status/mode/assignee.
- conversation list with last message/unread state.
- message timeline with text/media.
- distinguish customer, AI, human staff, system messages.
- delivery/read/failure status where available.
- Switch to HUMAN / Resume AI.
- assign staff.
- internal notes/tags later.
- linked order/booking/lead.
- show agent/prompt version per AI turn for diagnostics.
- safe retry of eligible failed outbound messages.

Human takeover prevents concurrent AI reply races through locking/mode checks.

## 9. Business actions

UI is capability-aware.

### Orders

- list/detail.
- source business/channel/conversation.
- item/quantity/price snapshots.
- customer details.
- payment/delivery metadata.
- status transitions.

### Bookings/Appointments

- service/date/time/contact/status.
- list/calendar views as implemented.
- reschedule/cancel subject to rules.

### Leads

- list/stage/source/assignee.
- originating conversation link.

Quotes/support cases receive dedicated views when first-class.

## 10. AI Agent management

Agent editor includes:

- name/description.
- enabled capabilities.
- default collections.
- knowledge sources.
- AI provider/model config.
- tone/behavior.
- escalation rules.
- follow-up behavior.
- safety/business restrictions.
- active prompt version.
- channel assignments.

Templates are starting points, not rigid business types.

## 11. Prompt management

Suggested prompt sections:

- core system role.
- business identity/context.
- tone/language.
- sales/service instructions.
- grounding rules.
- action/capability rules.
- order/booking/lead requirements.
- escalation rules.
- restrictions.
- custom instructions.

Prompt versions support draft, test, publish, archive, rollback. Mutable business facts come from current data, not permanently copied prompt text.

## 12. Training Studio

Supports:

- trainer identities by channel.
- detected training conversations.
- approve/reject examples.
- simulator customer message + ideal response pairs.
- text/media examples.
- candidate prompt/agent generation.
- source/context visibility.
- candidate diff.
- sandbox test.
- publish/discard/rollback.
- optional explicit auto-publish policy.

Training is behavior/prompt synthesis by default, not foundation-model fine-tuning.

## 13. AI provider configuration

Customer can use platform AI or BYOK if plan allows.

Configuration:

- provider type.
- API key/secret.
- compatible-provider base URL.
- connection test.
- model selection.
- task-specific assignment.
- supported parameters.

After save, show masked metadata only. Provide replace/revoke, not reveal.

Task keys may include default conversation, intent, image analysis, transcription, prompt synthesis, embeddings, and specialized extraction.

## 14. Knowledge/RAG

Customer manages FAQ, documents, policies, rich descriptions, and approved answer examples. Show indexing status/errors. Source updates/deletes trigger asynchronous vector lifecycle.

## 15. Media library

Media UI manages `media_assets` backed by the existing Media Storage service through the SaaS storage adapter.

Features:

- upload images/files.
- preview through authorized application access.
- search/filter by source/type/date.
- see where an asset is used.
- reuse assets in collection items.
- delete subject to reference/retention checks.
- display processing/error state.
- display tenant storage usage/quota where applicable.
- control private/public visibility only where business policy allows it.

The browser never receives Media Storage bearer credentials, filesystem paths, infrastructure admin URLs, or direct administrative APIs.

## 16. Messaging/automation limits

Customer may configure limits below platform/plan ceilings:

- max outgoing messages/minute.
- burst limit.
- max media messages/minute.
- max images per response.
- max AI turns/hour/day.
- max estimated tokens/day.
- follow-up timing/count.
- aggregation window within bounds.
- automatic human takeover behavior.

UI shows effective limit and constraining rule where useful.

## 17. Analytics / Usage

At business/channel/date scope show:

- inbound/outbound transport messages.
- logical turns.
- AI vs human replies.
- AI calls/tokens/cost estimate.
- Media Storage bytes/assets/uploads and provider media sends/cache reuse where relevant.
- failed/retried deliveries.
- orders/bookings/leads.
- conversion rates with defined denominator.
- top queried items/knowledge where privacy policy permits.
- plan quota consumption.

Do not conflate transport messages with AI turns.

## 18. Team

Tenant owner/admin can invite members, assign roles, restrict to selected businesses where supported, remove/suspend membership, and inspect relevant audit activity.

## 19. Settings

Includes tenant profile, business defaults, security/session controls, retention preferences within platform limits, notification preferences, billing later, and export/delete workflows.

## 20. Error and empty states

Critical screens include explicit states for loading, empty/new tenant, permission denied, disconnected channel, invalid provider key, processing job, partial media failure, storage quota reached, limit reached, and suspended tenant/plan.

Never silently fail automation configuration.

## 21. Customer Panel acceptance criteria

A new customer can go from signup to a tested connected automation without editing database rows, n8n workflows, Redis, Media Storage administration, or spreadsheets. A customer with multiple businesses/channels always understands which business/channel/data/agent an action applies to.