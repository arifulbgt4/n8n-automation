# Testing and acceptance specification

## 1. Testing layers

The implementation must include:

- unit tests for domain/validation/limit logic
- database integration tests
- API authorization/integration tests
- worker/queue integration tests
- n8n workflow contract tests
- channel adapter fixture tests
- end-to-end customer/admin flows
- load/burst tests
- security/tenant-isolation tests
- recovery/failure-injection tests

## 2. Authentication/tenancy tests

Must prove:

- signup/verification/signin/reset/session revocation work
- suspended/disabled account cannot operate
- Tenant A cannot read/write Tenant B by guessed IDs
- business-restricted staff cannot access another business
- viewer cannot mutate
- customer session cannot access super-admin API
- support/admin actions are audited
- revoked internal service credentials fail

## 3. Dynamic-data tests

- create collection with arbitrary allowed fields
- required/type/range/select validation
- JSONB data cannot bypass schema
- category/price are optional unless customer defines them
- shared collection linked to FB + WhatsApp returns same updated item
- channel override changes only target channel behavior
- invalid field keys cannot become SQL injection vectors
- schema edits handle existing rows predictably

## 4. Webhook/idempotency tests

- valid Facebook/Instagram/WhatsApp events route to correct account
- invalid signature/verification rejected
- duplicate provider event stored/processed once
- duplicate order action creates one order
- duplicate outbound job sends once semantically
- webhook acknowledgment remains fast under slow AI provider

## 5. Aggregation/multimodal tests

- multiple rapid text messages combine into configured logical turn
- 5-10 screenshots + question form one bounded turn
- aggregation does not lose persisted messages after Redis/worker restart
- oversized burst is bounded safely
- screenshots produce search hints but current DB facts control price/stock
- unsupported media produces safe response/error

## 6. Conversation/HUMAN tests

- AI mode replies normally
- staff takeover prevents new AI delivery
- pending AI output is suppressed after takeover
- resume AI restores automation
- Facebook API echo does not trigger false human takeover
- verified Page-owner manual reply can trigger HUMAN mode when enabled
- HUMAN mode blocks automated follow-up

## 7. Messaging/rate-limit tests

- per-minute and burst limits enforced atomically
- platform ceiling overrides higher customer setting
- plan ceiling overrides higher customer setting
- contact anti-abuse limit works
- queued messages resume at correct not-before time
- one high-volume tenant does not permanently starve another
- rate-limit retries do not duplicate sends

## 8. Media tests

- upload validates type/size/content
- media asset remains durable across app restart
- shared item gallery ordering preserved
- same-tenant duplicate asset dedup policy works
- no cross-tenant asset access
- Facebook reusable attachment ID reused
- stale remote media ID triggers one refresh/reupload path
- concurrent sends do not repeatedly upload same asset
- max images per response enforced
- continuation sends remaining images safely

## 9. AI provider tests

- provider connection test
- encrypted key is never returned in full
- task-specific routing selects correct model
- channel/agent/business default resolution order correct
- missing mandatory model config fails clearly
- permitted fallback works; forbidden fallback does not occur
- token/cost metadata emitted
- custom compatible base URL SSRF controls work

## 10. Prompt/training tests

- trainer identity routes to training, not production reply
- trainer scoped to correct business/channel
- simulator creates approved examples
- synthesis job uses declared base version/examples/schema/capabilities
- candidate does not become active automatically by default
- diff/test/publish/rollback lifecycle
- auto-publish only when explicitly enabled and checks pass
- prompt regression suite catches expected behavior changes

## 11. RAG/vector tests

- create/update source enqueues indexing
- source version change replaces/deactivates stale chunks
- vector retrieval restricted to tenant/business
- no cross-tenant nearest-neighbor leak
- structured price/stock query uses authoritative structured data
- deleted knowledge disappears after expected indexing lifecycle

## 12. Business-action tests

### Orders
- required information collected/validated
- current product data used
- order snapshot preserves historical price/title
- duplicate action idempotent
- channel/conversation attribution correct

### Bookings
- timezone/date validation
- duplicate booking action protection
- reschedule/cancel state rules

### Leads/quotes/support
- correct source attribution and permission/action validation

## 13. Usage/analytics tests

- one logical AI response with text + 3 images counts 1 AI turn and 4 outbound transport messages
- human reply counted separately
- media cache hit/miss measured correctly
- rollups reconcile with raw events within documented timing
- tenant usage never includes another tenant
- quota threshold/enforcement events work

## 14. Queue/recovery tests

- worker crash during job returns/retries safely
- retry backoff and max attempts
- permanent error goes dead-letter
- dead-letter retry after fix works
- duplicate consumer execution remains idempotent
- Redis restart does not delete durable PostgreSQL business data
- queue backlog/oldest age metrics available

## 15. n8n contract tests

- workflow resolves correct tenant/business/channel
- dynamic prompt/model config from app layer
- no Google Sheets dependency
- order/booking writes go through validated app service
- follow-up guards enforced
- n8n failure emits structured correlation/error information
- workflow version compatibility visible to operator

## 16. Load tests

Scenarios:

- burst of webhooks across many tenants
- single tenant burst within/above rate limits
- many simultaneous screenshots/media
- outbound media fanout
- queue backlog recovery
- analytics rollup load
- vector indexing burst after import

Measure latency, DB/Redis pressure, queue age, worker throughput, provider limits, and error rates.

## 17. Failure-injection tests

Simulate:

- PostgreSQL unavailable
- Redis unavailable/restart
- n8n unavailable
- media service unavailable
- AI provider timeout/5xx/auth failure
- Meta rate limit/5xx/auth expiry
- worker termination mid-job

Expected behavior must be bounded, observable, and non-corrupting.

## 18. Backup/recovery tests

- restore `app_db` backup into isolated environment
- restore n8n DB/workflows
- restore/reconcile media backup
- verify encrypted secrets remain decryptable with correct key procedure
- document actual measured recovery time

## 19. UI acceptance

Customer can complete core onboarding without developer intervention:

```text
signup -> business -> channel -> data -> AI config -> test -> activate
```

Customer can see which business/channel is currently selected on every relevant screen.

Super Admin can diagnose common failures without direct database edits.

## 20. Release gates

No production launch until:

- critical tenant isolation tests pass
- webhook signature/idempotency tests pass
- secret redaction review passes
- Meta end-to-end staging tests pass
- queue retry/dead-letter tests pass
- backup restore demonstrated
- monitoring/alerts operational
- Super Admin MFA enabled
- high-severity known security issues resolved
- pilot tenant acceptance criteria agreed and passed