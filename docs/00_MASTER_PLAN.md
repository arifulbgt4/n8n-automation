# Master plan

## 1. Product definition

The target product is a **multi-tenant AI business automation SaaS**. A customer signs up, creates one or more businesses, connects one or more communication channels for each business, defines the business data that the AI is allowed to use, configures or trains AI agents, and manages conversations and business actions such as orders, bookings, leads, appointments, quotes, or support cases.

The platform must support businesses that sell products, businesses that provide services, and businesses that use custom data models. The product must not assume that every customer is an e-commerce store.

The core execution model is:

```text
Customer/Super Admin Web Apps
            |
            v
       SaaS Backend/API
            |
            v
 PostgreSQL application DB
      ^       |       ^
      |       |       |
 Redis/Queue  |   Media Storage
      |       |       |
      +-------+-------+
              |
              v
          n8n + Workers
              |
      +-------+-------+
      |       |       |
 Facebook Instagram WhatsApp
              |
              v
         AI Providers
```

## 2. Primary outcomes

The platform must let a business owner:

- Sign up and securely access the customer panel.
- Create and manage multiple businesses under one SaaS account/tenant.
- Connect multiple Facebook Pages, Instagram professional accounts, and WhatsApp business numbers.
- Use the same catalog or business dataset across multiple channels.
- Use different catalogs, prompts, limits, or agent behavior on different channels when required.
- Create product, service, property, package, menu, course, or completely custom datasets.
- Define custom fields without database migrations per tenant.
- Upload and reuse images/files through the existing VPS media service.
- Configure AI providers, models, task-specific model selection, and BYOK API keys.
- Create AI agent profiles and attach them to businesses/channels.
- Train desired AI behavior from example human conversations.
- Review, test, publish, and roll back generated prompt versions.
- Receive and answer Facebook/Instagram/WhatsApp conversations.
- Switch a conversation between AI and HUMAN modes.
- Aggregate multi-message and multi-image customer turns before AI processing.
- Reuse previously uploaded Meta media IDs where the channel supports it.
- Manage orders, bookings, leads, appointments, quotes, and other enabled capabilities.
- View per-channel message transactions, AI usage, media usage, failures, and business outcomes.
- Configure safe customer-level automation limits within platform constraints.

The platform operator must be able to administer every tenant through a separate super-admin panel.

## 3. Core product principles

### 3.1 Application database is the source of truth

All durable SaaS business state lives in PostgreSQL `app_db`. Customer Panel, Super Admin Panel, workers, and n8n all operate on the same canonical business state.

The n8n internal database is not a mirror of the SaaS database. It stores only n8n's own workflows, credentials metadata, executions, and internal state.

### 3.2 No spreadsheet control plane

Google Sheets were useful in the earlier prototype but are removed from the target system. Business configuration, catalogs, prompts, providers, orders, support control, and runtime settings are managed through the SaaS UI and application database.

### 3.3 Configurable instead of e-commerce-only

A tenant creates collections and fields. Examples:

- Products: name, price, stock, color, size, images.
- Services: service name, duration, fee, location, available days.
- Properties: area, rent, bedrooms, location, furnishing.
- Courses: title, schedule, fee, instructor.
- Custom: any allowed field definition.

Customer-defined structure is implemented with schema metadata plus JSONB item data. Customers never receive permission to create arbitrary physical PostgreSQL tables or columns.

### 3.4 Capabilities drive automation

Business behavior is composed from capabilities rather than a fixed store/service switch. Initial capability set:

- Catalog/data search
- Product recommendation
- Order creation
- Booking creation
- Appointment scheduling
- Lead capture
- Quote request
- Support ticket/case
- FAQ/knowledge response
- Human handoff
- Follow-up
- Payment/delivery instruction

New capabilities can be added without changing the tenancy/channel model.

### 3.5 AI behavior is separate from business facts

Prompts define behavior and rules; live facts remain in the database/knowledge layer. Prices, stock, appointment availability, service fees, and other mutable facts must not be permanently copied into system prompts when they can be retrieved at runtime.

### 3.6 Async and idempotent messaging

Meta webhooks and application actions may retry or arrive in bursts. Message processing, media uploads, AI work, and outbound delivery must use idempotency keys, queueing, retries, and rate limiting.

## 4. Multi-tenant / multi-business / multi-channel model

```text
Tenant
|
+-- Memberships / Users
|
+-- Business A
|   +-- Facebook Page A
|   +-- Instagram A
|   +-- WhatsApp A
|   +-- Catalog/Collections
|   +-- Agent Profiles
|   +-- Conversations
|   +-- Orders/Bookings/Leads
|
+-- Business B
    +-- Facebook Page B
    +-- WhatsApp B
    +-- Different data/agents/actions
```

A single user may own or belong to multiple tenants in the long-term design. A tenant may own multiple businesses. A business may have many channel accounts. A catalog/collection may be linked to one or many channel accounts.

## 5. Shared catalog example

A business may create a single `Men's Fashion` catalog and attach it to both Facebook and WhatsApp. A price or stock update is made once in `app_db`; both channels immediately use the new data.

The same business may also have a separate wholesale catalog attached only to WhatsApp. Channel-specific visibility, price, prompt, and agent overrides are supported without duplicating the base entity unless needed.

## 6. Conversation and training model

Normal customer conversations and training conversations are distinct.

A customer may register a trainer identity such as a Facebook user/profile ID, WhatsApp number, Instagram identity, or use the in-panel training simulator. Messages from configured trainer identities are captured as training examples rather than ordinary production customer turns.

Prompt synthesis uses:

```text
Training examples
+ current active prompt/version
+ business and channel context
+ attached collections/schema
+ enabled capabilities
+ approved policy/guardrails
= proposed prompt/agent version
```

The system stores a version history. By default, a generated candidate requires review/test/publish. Auto-publish is optional and must be an explicit customer policy.

## 7. Messaging/media requirements

The platform must support:

- Text, image, audio, document, and other supported channel payloads.
- Customer bursts such as 5-10 screenshots followed by one question.
- A configurable short aggregation window that forms one logical conversation turn.
- Vision analysis linked to relevant business data search.
- Sending multiple images when the user requests them.
- Per-response image count limits and pagination/continuation behavior.
- Media asset deduplication via content hash.
- Persistent channel media mappings such as reusable Facebook attachment IDs or WhatsApp media IDs where supported.
- Fallback re-upload when a remote media ID is invalid or expired.
- Delivery queues, retries, dead-letter handling, and delivery status.

## 8. Rate limits and quotas

Limits exist at several layers:

- Provider/platform safety limits.
- SaaS plan limits.
- Tenant/business/channel limits.
- End-customer/conversation anti-abuse limits.
- AI turns/tokens/cost limits.
- Media/image limits.
- Follow-up limits.

The effective runtime limit is the most restrictive applicable limit. A tenant can lower its own limits but cannot exceed platform/provider safety ceilings.

## 9. AI provider strategy

The customer can configure supported providers such as OpenAI, Anthropic, Google/Gemini, and OpenAI-compatible providers. The architecture permits task-specific routing: one model for default chat, another for image analysis, another for transcription, etc.

Two commercial modes are supported by design:

- Platform-managed AI credentials.
- Customer BYOK credentials.

Secrets are encrypted and never returned in full after creation.

## 10. Knowledge/vector retrieval

PostgreSQL + pgvector is the initial retrieval implementation. Eligible knowledge sources include:

- FAQ
- Product/service descriptions
- Custom collection content
- Policies
- Documents
- Approved answer examples
- Selected training knowledge

Retrieval results are tenant/business scoped and must never cross tenant boundaries.

## 11. Analytics and business outcomes

The platform tracks both transport activity and logical AI activity. At minimum:

- Inbound messages
- Outbound messages
- Conversation turns
- AI turns
- Human replies
- Tokens/cost estimates
- Media sends/uploads/cache hits
- Delivery failures
- Conversations
- Orders/bookings/leads/quotes created
- Channel and account source
- Conversion metrics where meaningful

This data powers customer dashboards, super-admin monitoring, plan enforcement, billing readiness, and cost analysis.

## 12. Authentication and authorization

Customer authentication includes signup, signin, signout, password reset, email verification, secure sessions, and account security controls.

Super Admin authentication is logically separated and uses elevated RBAC. Super admins do not gain privileges merely by entering customer routes.

Tenant authorization is mandatory on every tenant-owned record.

## 13. Infrastructure

Target infrastructure:

- PostgreSQL for `app_db` and a separate n8n database.
- pgvector extension for semantic retrieval.
- Redis for caching, rate limiting, distributed locks, short-lived state, and queue coordination.
- Worker processes for async jobs.
- Existing VPS media service at `https://admin.openmusk.store/media` behind a storage adapter.
- n8n as workflow/orchestration runtime.
- Web/API services for customer and admin applications.

## 14. Operational safety

Required from the first production release:

- Audit logs for sensitive admin/customer actions.
- Encrypted secrets.
- Backups and tested restore procedures.
- Database migrations with rollback/forward-fix plan.
- Dead-letter queues.
- Health checks and monitoring.
- Structured logs and correlation/request IDs.
- Idempotent webhook processing.
- Webhook signature verification.
- Rate-limit protection.
- Tenant isolation tests.

## 15. Target end-to-end flows

### 15.1 Customer setup

```text
Signup -> Verify -> Create Tenant/Business -> Connect Channel ->
Create/Import Data -> Configure Agent/Provider -> Test -> Publish Automation
```

### 15.2 Normal customer message

```text
Meta Webhook -> Verify/Dedupe -> Resolve Channel/Tenant/Business ->
Aggregate Turn -> Detect Intent/Capability -> Retrieve Data/Knowledge ->
AI/Business Action -> Response Plan -> Queue -> Rate Limit -> Deliver -> Meter
```

### 15.3 Order/booking

```text
Conversation -> Collect required fields -> Validate ->
Create transaction through application service -> Commit app_db ->
Queue confirmation -> Send -> Customer Panel reflects transaction immediately
```

### 15.4 Training

```text
Trainer identity / panel simulator -> Capture examples -> Analyze ->
Generate candidate prompt/agent version -> Diff/Test -> Publish -> Audit
```

### 15.5 Human handoff

```text
AI conversation -> escalation/manual takeover -> HUMAN mode ->
AI replies stop -> staff/page owner responds -> history recorded ->
optional resume to AI -> AI uses updated conversation context
```

## 16. Explicit non-goals for the first implementation

These can be added later but must not block the core design:

- Building a custom foundation model.
- Fine-tuning a model from every training conversation by default; initial training is example-driven prompt/agent synthesis.
- Replacing n8n with a custom orchestration engine.
- Giving tenants direct SQL/database access.
- Storing media binaries in PostgreSQL.
- Using Google Sheets as a runtime source of truth.

## 17. Definition of planning completion

Planning is complete when the documents in this directory have been reviewed and the following are accepted:

- Domain entities and tenancy boundaries.
- Authentication/RBAC model.
- Channel and webhook contracts.
- Dynamic-data model.
- AI agent/training model.
- Messaging/media/queue model.
- n8n responsibilities and interfaces.
- Infrastructure and security rules.
- Analytics/limits/billing-ready model.
- Delivery roadmap and acceptance tests.

Only after that should runtime implementation begin.