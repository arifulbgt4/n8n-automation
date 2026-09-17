# Analytics, usage limits, and billing readiness

## 1. Goals

The platform must accurately measure transport activity, AI activity, media activity, and business outcomes. These metrics serve customer dashboards, super-admin operations, fair-use limits, future subscription/billing, and cost control.

## 2. Do not conflate units

Track these separately:

- `inbound_messages`: provider transport messages received.
- `outbound_messages`: provider transport messages sent.
- `conversation_turns`: logical grouped customer/assistant turns.
- `ai_calls`: model API calls.
- `ai_turns`: logical conversation responses involving AI.
- `human_replies`: replies from tenant staff/Page owner.
- `media_uploads`: uploads to channel/provider or storage.
- `media_sends`: outbound media transport messages.
- `remote_media_cache_hits`: send reused provider media ID.
- `embeddings`: embedding API operations/tokens.
- `training_jobs`: prompt synthesis/evaluation operations.
- `orders`, `bookings`, `leads`, etc.: business outcomes.

A single logical AI response may produce one AI turn but four outbound messages (one text + three images).

## 3. Usage event design

Write append-oriented `usage_events` for important metered units. Each event includes:

- tenant ID
- business ID when relevant
- channel account ID when relevant
- conversation/turn/job IDs when relevant
- event type
- quantity/unit
- provider/model/task key when AI-related
- estimated/actual cost fields when available
- correlation ID
- timestamp

Events must be idempotent where producer retries are possible.

## 4. Rollups

Raw events are not ideal for every dashboard request. Create hourly/daily rollups by dimensions such as:

- tenant
- business
- channel/platform
- provider/model
- event type

Keep enough raw retention to audit billable totals according to plan/policy.

## 5. Message transaction analytics

Per Page/WhatsApp number/Instagram account, Customer Panel should show:

- inbound messages
- outbound messages
- total conversations
- new contacts
- AI responses
- human responses
- failed/retried sends
- media sends
- channel activity over time

Super Admin can aggregate across tenants/platforms.

## 6. AI analytics

Track:

- calls by task
- input/output tokens where available
- cached tokens/provider-specific units when relevant
- latency
- model/provider
- error categories
- estimated cost
- platform-paid vs BYOK

For providers without exact token/cost metadata, label estimates clearly.

## 7. Business outcome analytics

Depending on enabled capabilities:

- orders created/confirmed/cancelled
- booking count/status
- lead count/stage
- quote/support requests
- source channel
- source agent/prompt version where useful

Conversion metrics must define the denominator explicitly. Do not show a vague conversion percentage without specifying whether it is per conversation, qualified lead, etc.

## 8. Media analytics

Track:

- storage bytes by tenant
- asset count
- outbound image/file count
- remote provider cache hit/miss
- media re-upload count
- media failure count
- processing time/errors

This helps quantify the benefit of reusable Meta media IDs.

## 9. Plan model

A plan can define entitlements/limits such as:

- businesses
- connected channels
- team seats
- collections
- custom fields/items
- messages/month
- AI turns/month
- AI tokens/cost budget
- media storage GB
- training jobs/month
- retention days
- BYOK availability
- platform-paid AI availability
- advanced analytics
- priority worker tier

Plan definition should be data-driven and versionable.

## 10. Limit types

### Hard limits

Operation is blocked once exceeded, e.g. number of channel accounts.

### Soft limits

Operation continues but customer/admin is warned, or overage is billed where supported.

### Rate limits

Throughput over a time window, e.g. outbound messages/minute.

### Budget limits

AI token/cost ceilings per day/month.

Each limit needs documented behavior when exceeded.

## 11. Effective limit resolution

Conceptual resolution:

```text
provider/platform hard safety ceiling
       AND
platform global ceiling
       AND
plan entitlement
       AND
super-admin tenant override
       AND
business/channel customer setting
       AND
contact/conversation anti-abuse policy
```

The effective allowed value is the most restrictive applicable constraint.

A customer may lower its own limit but cannot raise it above plan/platform/provider rules.

## 12. Rate limit examples

Configurable dimensions:

- max outgoing messages/minute per channel
- burst max over a few seconds
- max media messages/minute
- max images per logical response
- max AI turns/hour/day
- max tokens/day/month
- max follow-ups/contact/day
- max simultaneous active AI jobs per tenant

Provider-specific regulatory/messaging-window constraints are separate from customer-configured throughput.

## 13. Quota enforcement

For near-real-time quotas:

- Redis tracks fast counters/reservations.
- PostgreSQL usage events remain durable.
- Periodic reconciliation compares Redis counters and durable usage.

For expensive operations, consider reserve -> execute -> finalize usage semantics so parallel workers do not overspend a budget.

## 14. Billing readiness

The first release does not need to charge money to use this architecture, but billing must be possible without redesigning usage storage.

Suggested future entities:

- plans
- prices
- subscriptions
- invoices/payment references
- usage billing records
- credits
- overage records

Payment provider integration can be added later.

## 15. Platform-paid AI vs BYOK

### Platform-paid AI

- usage contributes to platform provider cost
- may have plan credit/budget
- super admin needs cost/margin visibility

### BYOK

- customer pays provider directly
- platform still meters calls/turns for plan/abuse limits
- provider token/cost estimates can still be shown for information

BYOK must not automatically mean unlimited platform messaging/compute/storage.

## 16. Alerts

Customer alerts:

- 70/80/90/100% quota thresholds as configured
- reconnect required
- AI budget near limit
- storage near limit

Super-admin alerts:

- sudden cost spike
- tenant anomaly
- provider-wide error spike
- message backlog/rate-limit pressure
- plan enforcement failures

## 17. Data freshness

Dashboard should state whether values are real-time, near-real-time, or rolled-up. Operational counters may update immediately while cost/analytics rollups lag by a few minutes.

## 18. Privacy

Analytics should favor counts/IDs over copying message content. Avoid storing message text in analytics tables. Link to canonical conversation only when authorized.

## 19. Acceptance criteria

Analytics/limits are acceptable when:

- page/account message counts reconcile with canonical message records within documented tolerances
- AI calls and outbound messages are distinct
- a tenant over a hard quota cannot race multiple workers to exceed it significantly
- customer settings cannot override provider/platform ceilings
- usage can be traced to tenant/business/channel/provider/model
- platform-paid AI cost can be estimated by tenant