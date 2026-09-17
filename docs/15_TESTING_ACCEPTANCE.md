# Testing and acceptance specification

## 1. Testing layers

Implementation includes:

- unit tests for domain/validation/limit logic.
- database integration tests.
- API authorization/integration tests.
- worker/queue integration tests.
- Media Storage adapter integration tests.
- n8n workflow contract + workflow-bundle import/deployment tests.
- channel adapter fixture tests.
- end-to-end customer/admin flows.
- load/burst tests.
- security/tenant-isolation tests.
- recovery/failure-injection tests.

Existing infrastructure is tested as an integration dependency; this repository does not test reinstalling Redis/n8n/Media Storage.

## 2. Authentication/tenancy tests

Must prove:

- signup/verification/signin/reset/session revocation work.
- suspended/disabled account cannot operate.
- Tenant A cannot read/write Tenant B by guessed IDs.
- business-restricted staff cannot access another business.
- viewer cannot mutate.
- customer session cannot access super-admin API.
- support/admin actions are audited.
- revoked internal service credentials fail.

## 3. Dynamic-data tests

- create collection with arbitrary allowed fields.
- required/type/range/select validation.
- JSONB data cannot bypass schema.
- category/price optional unless customer defines them.
- shared collection linked to FB + WhatsApp returns same updated item.
- channel override changes only target channel behavior.
- invalid field keys cannot become SQL injection vectors.
- schema edits handle existing rows predictably.

## 4. Webhook/idempotency tests

- valid Facebook/Instagram/WhatsApp events route to correct account.
- invalid signature/verification rejected.
- duplicate provider event processed once.
- duplicate order action creates one order.
- duplicate outbound job sends once semantically.
- webhook acknowledgment remains fast under slow AI provider.

## 5. Aggregation/multimodal tests

- rapid text messages combine into configured logical turn.
- 5-10 screenshots + question form one bounded turn.
- aggregation does not lose persisted messages after Redis/worker restart.
- oversized burst is bounded safely.
- screenshots produce search hints but DB facts control price/stock.
- unsupported media produces safe response/error.

## 6. Conversation/HUMAN tests

- AI mode replies normally.
- staff takeover prevents new AI delivery.
- pending AI output suppressed after takeover.
- resume AI restores automation.
- Facebook API echo does not trigger false human takeover.
- verified Page-owner manual reply can trigger HUMAN mode when enabled.
- HUMAN mode blocks automated follow-up.

## 7. Messaging/rate-limit tests

- per-minute and burst limits enforced atomically.
- platform ceiling overrides higher customer setting.
- plan ceiling overrides higher customer setting.
- contact anti-abuse limit works.
- queued messages resume at correct not-before time.
- one high-volume tenant does not permanently starve another.
- rate-limit retries do not duplicate sends.

## 8. Media Storage adapter tests

Against an isolated/test media user:

- authenticated storage usage request works.
- multipart upload accepts `file` and allowed `visibility`.
- uploaded file metadata maps external file/user IDs, MIME, size, kind, visibility, checksum, and content descriptor correctly.
- private file has no unintended public access.
- approved public file exposes provider-fetchable public URL only when service configuration allows it.
- authenticated content endpoint streams correct binary/MIME.
- list pagination works.
- visibility update works.
- hard delete removes file and updates usage/quota accounting.
- tenant Media Storage credential cannot list/read another tenant media user's files.
- bearer key never appears in browser payload/log snapshots.
- quota exceeded is a structured non-infinite-retry error.
- inactive/revoked storage user fails safely.
- service outage creates bounded retry/degraded behavior.

## 9. Application media tests

- `media_assets` survives app restart and references external storage file ID.
- shared item gallery ordering preserved.
- same-tenant checksum dedup policy works.
- no cross-tenant asset access/dedup leak.
- inbound screenshot is private by default.
- collection public media follows explicit policy.
- Facebook reusable attachment ID reused.
- stale remote media ID triggers one locked refresh/reupload path.
- concurrent sends do not repeatedly upload same asset.
- max images per response enforced.
- continuation sends remaining images safely.
- deleting one relationship does not delete an asset still referenced elsewhere.
- local Media Storage deletion does not falsely claim provider copies were deleted.

## 10. AI provider tests

- provider connection test.
- encrypted key never returned in full.
- task-specific routing selects correct model.
- channel/agent/business default resolution order correct.
- missing mandatory model config fails clearly.
- permitted fallback works; forbidden fallback does not occur.
- token/cost metadata emitted.
- custom compatible base URL SSRF controls work.

## 11. Prompt/training tests

- trainer identity routes to training, not production reply.
- trainer scoped to correct business/channel.
- simulator creates approved examples.
- training attachments follow private-media policy.
- synthesis job uses declared base version/examples/schema/capabilities.
- candidate not active automatically by default.
- diff/test/publish/rollback lifecycle.
- auto-publish only when explicitly enabled and checks pass.
- prompt regression suite catches expected behavior changes.

## 12. RAG/vector tests

- create/update source enqueues indexing.
- source version change replaces/deactivates stale chunks.
- vector retrieval restricted to tenant/business.
- no cross-tenant nearest-neighbor leak.
- structured price/stock query uses authoritative structured data.
- deleted knowledge disappears after expected indexing lifecycle.

## 13. Business-action tests

### Orders
- required information collected/validated.
- current product data used.
- order snapshot preserves historical price/title.
- duplicate action idempotent.
- channel/conversation attribution correct.

### Bookings
- timezone/date validation.
- duplicate booking protection.
- reschedule/cancel state rules.

### Leads/quotes/support
- correct source attribution and permission/action validation.

## 14. Usage/analytics tests

- one logical AI response with text + 3 images counts 1 AI turn and 4 outbound transport messages.
- human reply counted separately.
- storage upload and provider media upload are distinguishable units.
- remote media cache hit/miss measured correctly.
- rollups reconcile with raw events within documented timing.
- tenant usage never includes another tenant.
- quota threshold/enforcement events work.

## 15. Queue/recovery tests

- worker crash during job returns/retries safely.
- retry backoff and max attempts.
- permanent error goes dead-letter.
- dead-letter retry after fix works.
- duplicate consumer execution remains idempotent.
- Redis restart does not delete durable PostgreSQL business data.
- queue backlog/oldest age metrics available.

## 16. n8n runtime contract tests

- workflow resolves correct tenant/business/channel.
- dynamic prompt/model config comes from app layer.
- no Google Sheets dependency.
- business writes go through validated app service.
- follow-up guards enforced.
- media references use `media_asset_id`, not filesystem/admin URLs.
- n8n failure emits structured correlation/error information.
- workflow version compatibility visible to operator.

## 17. n8n workflow JSON bundle tests

- every JSON artifact parses/imports into the validated n8n version.
- manifest lists every required workflow file.
- committed exports contain no access token/API key/Media Storage bearer key/customer data.
- committed exports do not require production-only infrastructure/admin URLs.
- imported bundle remains inactive until explicit activation.
- required credentials/configuration are detectable before activation.
- duplicate webhook/schedule bundle cannot be activated accidentally in the deployment test.
- expected/deployed bundle version is recorded.
- blue/green cutover processes each test event once.
- rollback to previous compatible bundle restores processing.

## 18. Load tests

Scenarios:

- burst of webhooks across many tenants.
- single tenant burst within/above limits.
- simultaneous screenshots/media.
- outbound media fanout.
- queue backlog recovery.
- analytics rollup load.
- vector indexing burst after import.

Measure latency, DB/Redis pressure, queue age, worker throughput, storage/provider limits, and error rates.

## 19. Failure-injection tests

Simulate:

- app PostgreSQL unavailable.
- Redis unavailable/restart.
- n8n unavailable.
- Media Storage unavailable/quota exceeded/inactive tenant storage user.
- AI provider timeout/5xx/auth failure.
- Meta rate limit/5xx/auth expiry.
- worker termination mid-job.

Expected behavior is bounded, observable, and non-corrupting.

## 20. Backup/recovery tests

- restore `app_db` into isolated environment.
- confirm n8n runtime recovery responsibility plus import workflow bundle from Git.
- restore/reconcile Media Storage metadata database + physical file bytes.
- verify `media_assets` external references after media restore.
- verify encrypted secrets remain decryptable with correct key procedure.
- document measured recovery time.

## 21. UI acceptance

Customer completes:

```text
signup -> business -> channel -> data -> AI config -> test -> activate
```

without editing DB rows, n8n workflows, Redis, or infrastructure administration.

Customer can always see which business/channel is selected. Super Admin can diagnose common failures without direct DB edits.

## 22. Release gates

No production launch until:

- critical tenant isolation tests pass.
- webhook signature/idempotency tests pass.
- secret redaction review passes.
- Media Storage tenant/private/quota tests pass.
- n8n workflow JSON secret scan/import/cutover tests pass.
- Meta end-to-end staging tests pass.
- queue retry/dead-letter tests pass.
- backup restore demonstrated, including physical media bytes.
- monitoring/alerts operational.
- Super Admin MFA enabled.
- high-severity known security issues resolved.
- pilot tenant acceptance criteria passed.