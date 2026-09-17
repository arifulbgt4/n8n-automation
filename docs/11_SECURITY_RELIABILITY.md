# Security, privacy, reliability, and recovery

## 1. Security principles

- Least privilege everywhere.
- Tenant isolation is a hard boundary.
- Secrets are encrypted and never logged or re-displayed in full.
- External webhooks are verified and idempotent.
- Business mutations are validated server-side.
- Redis, n8n, Media Storage credentials, and infrastructure administration are not exposed to customer browsers.
- Production incidents must be diagnosable without weakening tenant privacy.

## 2. Threat boundaries

Primary boundaries:

- Browser <-> Customer/Super Admin apps.
- Web apps <-> Backend/API.
- Backend/API <-> PostgreSQL.
- Backend/API/workers <-> Redis/queues.
- Backend/workers/n8n <-> Media Storage user API.
- n8n/workers <-> Meta/AI providers.
- Tenant A <-> Tenant B.
- Customer tenant roles <-> platform super-admin roles.
- Application repository <-> separately managed infrastructure.

## 3. Secret management

Secrets include:

- Meta app/page/WhatsApp tokens.
- AI provider API keys.
- Media Storage bearer keys.
- Internal service credentials.
- Database/Redis credentials.
- Session signing/encryption keys.
- Webhook verification secrets.
- Platform-level n8n credentials where required.

Requirements:

- encrypt tenant/provider/storage secrets at rest using a dedicated application encryption/key-management strategy.
- keep encryption keys outside database content.
- support key rotation.
- never return full stored secret after creation.
- redact headers/body fields in logs and n8n execution data.
- avoid secrets in queue payloads; use references or short-lived scoped values.
- rotate/revoke credentials on channel/storage compromise or lifecycle change.
- never commit secrets to n8n workflow JSON artifacts.

## 4. Tenant isolation

Controls:

- every API resource checks tenant ownership.
- business-scoped permissions enforce assignment.
- PostgreSQL RLS where appropriate as defense in depth.
- queue jobs carry tenant IDs and workers re-verify ownership.
- Media Storage access maps tenant -> approved media user/credential.
- media asset records carry tenant ownership independent of storage metadata.
- vector search includes tenant/business filters.
- Redis keys are application/environment/tenant namespaced.
- caches are not shared across tenants unless data is truly global/public.

Preferred Media Storage isolation is one media user/account per SaaS tenant.

## 5. Input validation

Validate:

- IDs and ownership.
- dynamic field schemas/values.
- URLs and uploaded file types/sizes.
- AI structured outputs against schemas.
- order/booking numeric values and current source data.
- callback URLs/redirects.
- custom compatible-provider base URLs against SSRF/network policy.

Do not let customer-supplied URLs access internal metadata/private networks without an explicit secure proxy policy.

## 6. File/media security

The Media Storage service already performs MIME/extension validation, safe storage naming, checksum generation, quota checks, and private/public access behavior. The SaaS adds business authorization/policy on top.

Requirements:

- keep tenant Media Storage bearer keys server-side.
- default screenshots, conversations, training files, and sensitive documents to private.
- use public visibility only for approved catalog/business media when required.
- never trust filename alone for policy decisions.
- enforce product-level size/type rules even if storage also validates.
- do not execute uploaded content.
- serve/proxy content with safe content type/disposition.
- use storage file UUID/checksum metadata; never expose filesystem paths.
- audit sensitive delete/export actions.

## 7. Webhook security

For Meta/provider callbacks:

- verify signature/app secret/token as required.
- validate expected account identifiers.
- deduplicate event/message IDs.
- bound request size.
- acknowledge quickly after durable receipt/enqueue.
- reject unsupported methods/types safely.
- rate-limit abusive/unverified traffic.

## 8. Authentication security

- strong password hashing.
- email verification.
- one-time expiring password reset tokens.
- HttpOnly/Secure/SameSite session cookies where applicable.
- CSRF protection for cookie sessions.
- session revocation.
- MFA for super admins; customer MFA roadmap.
- brute-force/login rate limits.
- security event logging.

## 9. Authorization failures

Return safe 403/404 behavior without leaking another tenant's resource existence. Log sufficient internal context without exposing it to caller.

## 10. AI security

AI outputs are untrusted input.

Controls:

- structured output validation.
- tool/capability allowlist.
- server-side mutation validation.
- tenant prompt/data boundaries.
- no unnecessary secrets in prompts.
- avoid broad logging of full system/provider payloads.
- retrieved documents/user messages cannot grant server privileges or new tools.
- human handoff for uncertain/high-risk transactional cases according to policy.

## 11. Dynamic collection security

Customer-defined schemas are metadata, not SQL. Field keys/labels/filters are never interpolated into raw SQL without safe mapping/parameterization. Validation/query complexity limits prevent abusive schemas.

## 12. Rate limits and abuse prevention

Apply limits to:

- authentication attempts.
- API requests.
- media uploads.
- webhook/event volume where appropriate.
- AI calls.
- outbound messaging.
- training jobs.
- imports/exports.

Tenant plan limits complement security rate limits.

## 13. Audit logs

Audit at minimum:

- tenant/member/role changes.
- channel connect/disconnect/credential replacement.
- AI provider credential changes.
- tenant Media Storage account/key lifecycle where application-managed.
- prompt publish/rollback.
- training auto-publish changes.
- plan/limit changes.
- order/booking corrective admin edits.
- exports/deletion.
- super-admin support access/impersonation.
- queue recovery/destructive actions.
- n8n workflow bundle deployment/activation/rollback.

## 14. Application logging

Structured logs include timestamp, service, environment, severity, correlation/request/job ID, relevant tenant/business/channel IDs, error code/category, and duration.

Never log:

- full access tokens/API keys/Media bearer keys.
- passwords/reset tokens.
- authorization headers.
- unnecessary full message/media contents.
- raw n8n credential payloads.

## 15. Backup strategy

### PostgreSQL application data

- scheduled backups.
- PITR if feasible.
- backup encryption.
- off-machine/off-volume copy.
- restore tests.

### Media Storage

A recoverable media service requires both:

- Media Storage metadata/database backup.
- physical Media Storage file-tree backup.

`app_db` backup alone is insufficient because it stores references, not file bytes.

### Redis

Redis is not canonical truth. Persistence may improve recovery, but correctness cannot depend on Redis being the only copy of important state.

### n8n

Infrastructure operations own n8n runtime/internal DB backup. This repository additionally keeps sanitized workflow JSON + manifest in Git so application workflow definitions are recoverable independently of editor state.

## 16. Recovery objectives

Define before launch:

- RPO.
- RTO.
- queue recovery behavior.
- Media Storage recovery behavior.
- workflow bundle recovery/cutover behavior.
- webhook replay/manual reconciliation procedure.

## 17. Failure modes

### PostgreSQL unavailable

- reject state-changing operations safely.
- do not acknowledge durable webhook processing if event was not safely recorded according to ingest design.
- alert operators.

### Redis unavailable

- use designed durable fallback/outbox.
- do not lose persisted business state.
- degrade rate-limited/async features safely.

### Media Storage unavailable

- text-only flows may continue if policy allows.
- media sends/uploads queue/retry.
- do not lose `media_assets` ownership/reference state.
- surface storage/quota/file errors distinctly.

### AI provider unavailable

- configured fallback only if allowed.
- otherwise safe error/handoff.
- no duplicate transactional actions on retry.

### Meta/provider unavailable

- bounded retries.
- honor retry-after.
- surface backlog/failure.

### n8n unavailable

- management panels remain available where possible.
- incoming events are durably accepted/queued if ingest design supports it.
- operators see automation outage/workflow health failure.

## 18. Database migrations

- version-controlled migrations only.
- backup/recovery consideration for destructive changes.
- expand/migrate/contract for low downtime.
- workers and deployed n8n bundle must tolerate compatible schema during rollout.
- no manual production table edits without audited emergency procedure.

## 19. n8n workflow artifact security

Committed workflow JSON must be treated as source code.

Before commit/import verify:

- no customer/provider/storage secrets.
- no n8n credential export.
- no customer conversation/sample sensitive content.
- no unnecessary infrastructure hostname/admin URL.
- no production-only credential ID as the sole portability mechanism.
- expected workflow bundle/API contract version is updated.

Production bundle changes use review, inactive testing, controlled cutover, and rollback metadata.

## 20. Privacy and retention

Define retention for:

- conversations/messages.
- raw webhook payloads.
- media attachments.
- training examples.
- AI provider request metadata.
- audit logs.
- usage events.

Tenant deletion respects legal/retention policy while revoking access immediately according to product rules, and eventually deletes/revokes tenant Media Storage content/account according to approved lifecycle.

## 21. Data export/deletion

Exports/deletion are authenticated/audited. Generated exports use Media Storage with controlled access and never contain decrypted provider/storage secrets.

## 22. Observability/security alerts

Alert on:

- repeated auth failures.
- tenant-isolation error signals.
- webhook signature failure spike.
- queue backlog/dead-letter growth.
- app DB/Redis/Media/n8n integration outage.
- AI cost anomaly.
- provider auth failures/reconnect spike.
- storage quota/capacity error spike.
- backup failure.
- worker heartbeat loss.
- workflow bundle mismatch/required workflow missing.

## 23. Reliability patterns

- idempotency keys.
- database unique constraints.
- transactional outbox.
- bounded retries with backoff/jitter.
- dead-letter queues.
- distributed locks plus DB versioning/constraints.
- health/readiness checks.
- graceful worker shutdown.
- versioned workflow bundle with blue/green cutover for major changes.

## 24. Acceptance criteria

Security/reliability is not complete until:

- tenant escape tests fail closed.
- secrets cannot be retrieved from normal logs/read APIs/workflow JSON.
- Media Storage bearer credentials never reach browsers.
- duplicate webhooks/actions remain idempotent.
- backup restoration is demonstrated, including physical media bytes.
- worker/Redis restart does not lose durable business state.
- privileged admin/deployment actions are auditable.
- AI/Meta/Media/n8n failure produces bounded observable degradation rather than silent corruption.