# AI agents, training, prompts, providers, and RAG

## 1. AI architecture goals

The AI layer must be configurable per tenant/business/channel, provider-independent, grounded in current business data, and safe to evolve through versioned prompt/agent releases.

The product does **not** assume one global prompt or one global model.

## 2. Agent profile

An `agent_profile` represents reusable business behavior.

Suggested configuration:

- Name and description.
- Business scope.
- Enabled capabilities.
- Default collections/catalogs.
- Knowledge sources.
- Default provider/model configuration.
- Prompt version.
- Tone/language behavior.
- Escalation rules.
- Follow-up policy.
- Runtime limits.
- Channel assignments.

One agent can serve Facebook + WhatsApp + Instagram for the same business, while channel-specific overrides remain possible.

## 3. Capabilities

Capabilities describe actions the agent may perform. Initial list:

- `DATA_SEARCH`
- `CATALOG_RECOMMENDATION`
- `ORDER_CREATE`
- `ORDER_STATUS`
- `BOOKING_CREATE`
- `APPOINTMENT_CREATE`
- `LEAD_CAPTURE`
- `QUOTE_REQUEST`
- `FAQ_KNOWLEDGE`
- `SUPPORT_CASE`
- `HUMAN_HANDOFF`
- `FOLLOW_UP`
- `PAYMENT_INSTRUCTION`

Capabilities are permissioned tools, not merely prompt wording. The runtime must verify an action is enabled before executing it.

## 4. Prompt structure

Prompts should be composed from typed sections instead of one unstructured string where possible:

- Core role.
- Business identity.
- Tone/language.
- Data grounding policy.
- Collection/search instructions.
- Enabled capability instructions.
- Order/booking/lead requirements.
- Human escalation rules.
- Safety/restrictions.
- Custom customer instructions.
- Runtime injected context placeholders.

The active assembled prompt may be cached, but its canonical sections/version remain in PostgreSQL.

## 5. Facts vs behavior

Prompt text defines behavior. Runtime data defines facts.

Bad pattern:

```text
"Product A costs 1,800 BDT and has 4 units left."
```

Preferred pattern:

```text
"Use the provided current catalog context for price and stock. Never invent or retain stale values."
```

Then the runtime retrieves current values from `app_db`.

This applies to prices, stock, service fees, availability, delivery rules that are modeled data, and other mutable state.

## 6. AI provider registry

Supported provider adapters should initially cover:

- OpenAI
- Anthropic
- Google/Gemini
- OpenAI-compatible HTTP providers

Architecture must permit additional adapters.

Each provider connection stores:

- provider type
- encrypted key/secret
- optional base URL
- ownership mode (`PLATFORM`, `BYOK`)
- connection test state
- metadata such as key suffix only

## 7. Task-specific model routing

A business/account may use different models for different tasks.

Initial task keys:

- `DEFAULT_CHAT`
- `INTENT_CLASSIFICATION`
- `IMAGE_ANALYSIS`
- `AUDIO_TRANSCRIPTION`
- `STRUCTURED_EXTRACTION`
- `PROMPT_SYNTHESIS`
- `EMBEDDINGS`
- optional moderation/safety tasks

Routing resolution:

```text
channel override
 -> agent/task override
 -> business task default
 -> tenant/platform allowed default
```

If policy requires an explicit model and none is available, fail clearly instead of silently switching to an unrelated provider.

## 8. Provider/model parameters

Configurable where supported:

- model
- temperature
- max output tokens
- timeout
- retry policy
- response format / JSON schema capability
- vision/audio support metadata
- context-window metadata
- cost metadata for estimates

Do not expose provider parameters that the selected provider/model does not support.

## 9. Training concept

Training is initially **behavioral example-driven prompt/agent synthesis**, not automatic foundation-model fine-tuning.

Customers teach the agent by demonstrating how a human owner/staff member would ideally answer representative customer messages.

Training sources:

- Configured Facebook trainer profile/user identity.
- Configured WhatsApp trainer number.
- Configured Instagram trainer identity where technically reliable.
- Customer Panel Training Studio simulator.
- Manually entered paired examples.
- Approved historical conversations in a later phase.

## 10. Trainer identity routing

Before a channel message enters normal production AI handling:

```text
Is sender a configured trainer identity for this scope?
  yes -> training pipeline
  no  -> production conversation pipeline
```

Trainer identities are scoped to tenant/business/channel/agent as configured. A trainer identity on one Page must not automatically train another Page/business.

## 11. Training example model

A training example can contain:

- customer-like input text
- one or more screenshots/images/files
- ideal owner/staff response
- label/use-case/intent
- related collection items
- capability demonstrated
- approved/rejected status
- channel/business context

Examples remain auditable and removable.

## 12. Prompt synthesis inputs

A training job should use only approved inputs:

```text
active prompt/base version
+ approved training examples
+ business/agent settings
+ current collection schemas (not necessarily all data rows)
+ enabled capabilities/tool contracts
+ safety/grounding rules
+ selected language/tone requirements
= candidate prompt version
```

Full mutable catalog contents should normally not be baked into the prompt.

## 13. Prompt version lifecycle

States:

- `DRAFT`
- `CANDIDATE`
- `ACTIVE`
- `ARCHIVED`
- optionally `REJECTED`

Flow:

```text
new examples
 -> training job
 -> candidate vN
 -> automated checks
 -> customer test/diff
 -> publish
 -> vN becomes active
 -> previous remains archived/rollbackable
```

Every version records base version, source, model, training job, author/approver, and publish time.

## 14. Auto-publish

Default: OFF.

If later enabled by customer:

- Must be an explicit setting.
- Only eligible training jobs that pass validation may auto-publish.
- Major structural/safety changes should still require manual review.
- Automatic rollback/disable policy may trigger on severe post-publish failures.
- Audit every auto-publish.

## 15. Prompt testing

Training Studio should provide a sandbox that can test a candidate against:

- customer-entered test messages
- saved regression examples
- screenshots/media where supported
- expected tool/capability actions

Testing must not create real orders/bookings or send real channel messages unless the test explicitly uses a safe sandbox mode.

## 16. Regression dataset

Each agent should accumulate approved test cases representing important behaviors:

- correct product/service lookup
- refuses to invent unknown price/stock
- correct order/booking field collection
- human escalation
- language/tone examples
- out-of-scope handling
- media/screenshot examples

A new candidate should be evaluated against these before publish.

## 17. Structured tool/action execution

Do not let the LLM directly perform arbitrary database mutations.

The LLM proposes a structured action, e.g.:

```json
{
  "tool": "create_order",
  "arguments": {
    "items": [...],
    "customer": {...}
  }
}
```

The application validates:

- capability enabled
- tenant/business scope
- current item data/availability
- required fields
- permissions/policies
- idempotency

Only then does it execute the action.

## 18. Dynamic schema awareness

For custom collections, runtime context includes collection schema definitions and only relevant item results.

Example service schema:

```text
Service Name: text
Duration: number
Fee: currency
Available Days: multi-select
Location: text
```

The agent can use this structure without a hardcoded `category` or `price` requirement.

## 19. Suggested automation from schema

The product may suggest capabilities based on a collection, but must request approval before enabling transactional behavior.

Example:

```text
Detected fields: service, duration, available date/time
Suggestion: enable Booking capability
```

AI suggestions never directly create arbitrary physical database tables.

## 20. RAG / knowledge retrieval

Initial vector layer: PostgreSQL pgvector.

Eligible sources:

- FAQ
- policies
- documents
- collection descriptions
- product/service descriptions
- approved answer examples
- curated knowledge text

Pipeline:

```text
source create/update
 -> normalize/extract text
 -> chunk
 -> embedding job
 -> pgvector storage
```

Runtime:

```text
customer query
 -> tenant/business-scoped retrieval
 -> optional keyword/structured search
 -> rerank/filter
 -> bounded context
 -> model
```

## 21. Hybrid retrieval

Structured business facts should use structured queries first. Vector search is not a replacement for exact stock/price/order status queries.

Examples:

- "What is the price of SKU X?" -> structured collection lookup.
- "What is your return policy?" -> knowledge/vector retrieval.
- Screenshot/product similarity -> vision interpretation + structured/vector candidate lookup depending on available data.

## 22. Vector isolation

Every embedding/chunk includes tenant/business/source ownership. Similarity queries must include ownership filters. Cross-tenant vector retrieval is a critical security failure.

## 23. Embedding lifecycle

When source content changes:

- increment source version
- enqueue re-embedding
- prevent stale version from remaining active after replacement is ready
- track model/version used

Deletion must remove/deactivate associated chunks.

## 24. AI cost and usage

Every AI call records safe metadata:

- tenant/business/channel/conversation/job
- provider/model/task key
- input/output token counts when available
- estimated/actual cost
- latency
- success/error category
- prompt/version ID, not necessarily raw full prompt in normal logs

Raw provider request/response logging should be minimized and retention-controlled.

## 25. Safety and grounding requirements

Agents must:

- never invent database facts when required data is missing
- distinguish unknown/unavailable from out-of-stock
- respect enabled capabilities only
- not reveal system prompts/secrets/internal identifiers on request
- not cross tenant/business data boundaries
- obey HUMAN mode and stop automation when required
- require application validation before transactional writes

## 26. Fallback behavior

If AI provider fails:

- retry only according to task policy
- optional configured fallback model/provider if explicitly allowed
- do not silently switch to a provider that violates customer BYOK/data policy
- surface degraded state when repeated failures occur
- transactional actions must remain idempotent across retries

## 27. Acceptance criteria

AI architecture is acceptable when:

- two channels can share one agent/data set while another uses overrides
- customers can configure task-specific models without editing n8n
- trainer messages create training examples instead of production replies
- candidate prompts are versioned/testable/rollbackable
- live price/stock/service data is retrieved at runtime
- vector retrieval cannot return another tenant's content
- LLM-proposed order/booking actions cannot bypass server validation