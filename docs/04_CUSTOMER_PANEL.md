# Customer Panel specification

## 1. Purpose

`customer-panel` is the tenant-facing SaaS application. It is the primary place where customers sign up, configure businesses and channels, manage business data, train AI agents, operate conversations and transactions, inspect usage, and control automation behavior.

The UI must hide infrastructure complexity such as raw n8n workflow IDs, Redis keys, queue internals, and database structure unless an advanced diagnostic feature intentionally exposes safe metadata.

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

Navigation should adapt to enabled capabilities. For example, a service business may show `Bookings` instead of emphasizing `Orders`.

## 3. Onboarding flow

Minimum guided onboarding:

1. Sign up.
2. Verify email.
3. Create tenant/organization.
4. Create first business.
5. Choose a business/use-case hint (optional, used only for templates).
6. Connect Facebook/Instagram/WhatsApp or skip for later.
7. Create/import first data collection or choose a template.
8. Create/select an AI agent template.
9. Configure platform AI or BYOK provider.
10. Test in simulator.
11. Publish/activate automation.

Onboarding should preserve progress and permit returning later.

## 4. Dashboard

Tenant/business dashboard should show actionable state, not only vanity metrics.

Examples:

- Connected channels and health.
- Messages today/7 days/30 days.
- Open AI and HUMAN conversations.
- Failed deliveries/reconnect-required channels.
- AI turns/tokens/cost estimate.
- Orders/bookings/leads by channel.
- Conversion summaries.
- Queue/backlog warnings relevant to the customer.
- Training candidates awaiting review.
- Usage vs plan limits.

Filters: tenant business, channel, date range.

## 5. Businesses

Customers can:

- Create multiple businesses.
- Rename/archive businesses.
- Configure timezone, currency, language/locale, contact information, delivery/payment defaults, and general settings.
- Assign team members to specific businesses.
- Set business-level default AI agent, model configuration, data collections, and limits.
- View all connected channels for the business.

Destructive operations require confirmation and respect transactional/history retention rules.

## 6. Channel management

### Channel list

Display:

- Platform and account name.
- Connection status.
- Last webhook/message activity.
- Assigned business.
- Assigned/shared collections.
- Assigned agent profile.
- Messaging/AI limits.
- Reconnect/permission warnings.

### Connect channel

Customer can connect:

- Facebook Page(s)
- Instagram professional account(s)
- WhatsApp Business account/phone number(s)

Future channel adapters should fit the same UX.

### Channel detail

Customer may configure:

- Channel display name.
- Active/paused state.
- Default agent/profile.
- Attached collections/catalogs.
- Channel-specific prompt/behavior override.
- Channel-specific limits below platform ceilings.
- Follow-up configuration.
- Human-handoff behavior.
- Trainer identities.
- Media send preferences.
- Connection/test status.

## 7. Dynamic Data / Catalog builder

Customers are not limited to Products.

### Create collection

Examples/templates:

- Products
- Services
- Properties
- Menu
- Packages
- Courses
- FAQ-like structured list
- Blank custom collection

### Field builder

Customer can add/reorder/configure fields such as:

- Text / long text
- Number / decimal
- Currency
- Boolean
- Date/date-time
- Email / phone / URL
- Single-select / multi-select
- Image/media
- Relation/reference

For each field, configure label, key, type, required, AI visibility, search/filter/sort behavior, options, and validation.

The UI must explain that fields are application-defined, not raw SQL columns.

### Table/data editor

Customers can:

- Add/edit/delete/archive items.
- Bulk select/update where safe.
- Search/filter/sort.
- Upload one or many images/files.
- Reorder gallery media.
- Import/export supported formats in a later phase.
- View validation errors.

### Channel linking

A collection can be linked to one or many channels. Customer can see the impact of changes across linked channels.

### Overrides

Where enabled, a channel can override selected fields such as visibility or price while keeping base data shared.

## 8. Conversations / Inbox

The Customer Panel should provide a unified inbox across supported channels.

Features:

- Filter by business/channel/status/AI-HUMAN mode/assignee.
- Conversation list with last message and unread state.
- Message timeline with text and media.
- Distinguish customer, AI, human staff, and system messages.
- Delivery/read/failure status where provider exposes it.
- Switch to HUMAN mode / Resume AI.
- Assign staff.
- Internal notes/tags in a later phase.
- View linked order/booking/lead.
- See which agent/prompt version answered each AI turn for diagnostics.
- Retry eligible failed outbound messages through safe controls.

A manual human reply must prevent concurrent AI reply races through conversation locking/mode checks.

## 9. Business actions

UI is capability-aware.

### Orders

- Order list/detail.
- Source business/channel/conversation.
- Items/quantities/prices snapshots.
- Customer details.
- Payment/delivery metadata.
- Status transitions.
- Search/filter/export later.

### Bookings/Appointments

- Calendar/list views later.
- Service/date/time/contact/status.
- Reschedule/cancel subject to rules.

### Leads

- Lead list/stage/source/assigned staff.
- Link back to originating conversation.

### Quotes/Support cases

Add dedicated views when those capabilities become first-class.

## 10. AI Agent management

Customers can create multiple agent profiles per business.

Agent editor includes:

- Name/description.
- Enabled capabilities.
- Default data collections.
- Knowledge sources.
- Default AI provider/model config.
- Tone/behavior controls.
- Human escalation rules.
- Follow-up behavior.
- Safety/business restrictions.
- Active prompt version.
- Channel assignments.

Provide templates for common use cases, but templates are starting points, not rigid business types.

## 11. Prompt management

Advanced users can manually edit prompt sections. Suggested sections:

- Core system role.
- Business identity/context.
- Tone and language behavior.
- Sales/service instructions.
- Data-grounding rules.
- Action/capability rules.
- Order/booking/lead collection rules.
- Human-escalation rules.
- Restrictions/never-do rules.
- Custom instructions.

Prompt versions support draft, test, publish, archive, and rollback.

Mutable facts should be retrieved from current data rather than hardcoded into prompt text.

## 12. Training Studio

The Training area supports:

- Register trainer identities by channel.
- View detected training conversations.
- Mark/approve examples.
- Create simulated customer message + ideal business reply examples directly in the panel.
- Include text and supported media examples.
- Generate a new prompt/agent candidate.
- See what source examples/data/capabilities were used.
- Compare candidate vs active version.
- Test candidate in a sandbox simulator.
- Publish or discard.
- Roll back to previous version.
- Configure optional auto-publish policy with explicit warning.

Training is prompt/agent synthesis by default, not foundation-model fine-tuning.

## 13. AI provider configuration

Customer can use platform AI or BYOK if allowed by plan.

Provider form:

- Provider type.
- API key/secret.
- Base URL for compatible providers.
- Connection test.
- Model selection.
- Task-specific assignment.
- Parameters such as temperature/token limit where supported and allowed.

After saving, show only masked secret metadata. Provide replace/revoke, not reveal.

Task keys can include:

- Default conversation
- Intent classification
- Image/screenshot analysis
- Audio transcription
- Prompt synthesis/training
- Embeddings
- Specialized extraction

## 14. Knowledge/RAG

Customer can manage knowledge sources such as:

- FAQ entries.
- Documents.
- Policies.
- Rich descriptions.
- Approved answer examples.

Show indexing status/errors. Deleting/updating a source must update embeddings asynchronously.

## 15. Media library

Media UI manages assets stored by the OpenMusk/VPS media service through the application storage adapter.

Features:

- Upload images/files.
- Preview.
- Search/filter by source/type/date.
- See where an asset is used.
- Reuse an existing asset in collection items.
- Delete subject to reference/retention checks.
- Display processing/error state.

Do not expose raw storage credentials or unrestricted filesystem paths.

## 16. Messaging/automation limits

Customer may configure limits below platform/plan ceilings:

- Max outgoing messages/minute.
- Burst limit.
- Max media messages/minute.
- Max images per response.
- Max AI turns/hour/day.
- Max estimated tokens/day.
- Follow-up enabled and timing/count limits.
- Conversation aggregation window within allowed bounds.
- Automatic human takeover behavior where supported.

The UI shows the effective limit and why it is lower than a requested value if plan/platform/provider constraints apply.

## 17. Analytics / Usage

At business/channel/date scope show:

- Inbound/outbound transport messages.
- Logical conversation turns.
- AI vs human replies.
- AI calls/tokens/cost estimate.
- Media sends, uploads, cache reuse.
- Failed/retried deliveries.
- Orders/bookings/leads.
- Conversion rates where valid.
- Top queried collection items/knowledge where privacy policy allows.
- Current plan quota consumption.

Do not conflate `messages` with `AI turns`; both are displayed separately.

## 18. Team

Tenant owner/admin can:

- Invite members.
- Assign roles.
- Restrict to selected businesses when supported.
- Remove/suspend membership.
- Inspect relevant audit activity.

## 19. Settings

Includes:

- Tenant profile.
- Business defaults.
- Security/session controls.
- Data retention preferences within platform limits.
- Notification preferences.
- Plan/billing later.
- Export/delete account workflows.

## 20. Error and empty states

Every critical screen needs explicit states:

- Loading.
- Empty/new tenant.
- Permission denied.
- Disconnected channel.
- Provider key invalid.
- Queue/job still processing.
- Partial media failure.
- Limit reached.
- Suspended plan/tenant.

Never silently fail automation configuration.

## 21. Customer Panel acceptance criteria

A new customer must be able to go from signup to a tested connected automation without editing database rows, n8n workflows, Redis, or Google Sheets. A customer with two businesses and several channels must always understand which business/channel/data/agent an action applies to.