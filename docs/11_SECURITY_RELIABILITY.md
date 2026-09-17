# Security, privacy, reliability, and recovery

## 1. Security principles

- Least privilege everywhere.
- Tenant isolation is a hard boundary.
- Secrets are encrypted and never logged or re-displayed in full.
- External webhooks are verified and idempotent.
- Business mutations are validated server-side.
- Redis/n8n/media storage are not exposed directly to customer browsers.
- Production incidents must be diagnosable without weakening tenant privacy.

## 2. Threat boundaries

Primary boundaries:

- Browser <-> Customer/Super Admin apps.
- Web apps <-> Backend/API.
- Backend/API <-> PostgreSQL.
- Backend/API/workers <-> Redis/queues.
- Backend/workers <-> media storage.
- n8n/workers <-> Meta/AI providers.
- Tenant A <-> Tenant B.
- Customer tenant roles <-> platform super-admin roles.

## 3. Secret management

Secrets include:

- Meta app/page/WhatsApp tokens.
- AI provider API keys.
- Internal service credentials.
- Database/Redis credentials.
- Session signing/encryption keys.
- Webhook verification secrets.

Requirements:

- Encrypt tenant/provider secrets at rest using a dedicated application encryption key/key-management strategy.
- Keep encryption keys outside database content.
- Support key rotation.
- Never return full stored secret after creation.
- Redact headers/body fields in logs and n8n execution data.
- Avoid secrets in queue payloads; use references or short-lived scoped values.
- Rotate/revoke credentials on channel disconnect or compromise.

## 4. Tenant isolation

Controls:

- Every API resource check includes tenant ownership.
- Business-scoped permissions enforce business membership/assignment.
- PostgreSQL RLS where appropriate as defense in depth.
- Queue jobs carry tenant IDs and workers verify ownership before loading target resources.
- Media authorization checks tenant ownership.
- Vector search includes tenant/business filters.
- Redis keys are tenant-namespaced.
- Cache entries cannot be shared across tenants unless the data is truly global/public.

## 5. Input validation

Validate:

- IDs and ownership.
- Dynamic field schemas and values.
- URLs and uploaded file types/sizes.
- AI structured outputs against schemas.
- Order/booking numeric values and current source data.
- Callback URLs/redirects to prevent open redirects/SSRF.
- Custom OpenAI-compatible base URLs against SSRF/network policy.

Do not let customer-supplied provider URLs access internal metadata/private network ranges without explicit secure proxy policy.

## 6. File/media security

- Validate MIME by file content, not filename alone.
- Define max sizes/dimensions/durations.
- Sanitize filenames/metadata.
- Do not execute uploaded content.
- Serve files with safe content disposition/type.
- Private conversation files require authorized access.
- Public catalog images should use unguessable stable identifiers or controlled signed access.
- Scan file types that create malware risk as appropriate.

## 7. Webhook security

For Meta/provider callbacks:

- Verify signature/app secret/token according to provider requirements.
- Validate expected account identifiers.
- Deduplicate event/message IDs.
- Bound request size.
- Acknowledge quickly after durable receipt/enqueue.
- Reject unsupported methods/types safely.
- Rate-limit abusive/unverified traffic.

Verification tokens are not access tokens and must be treated according to their own purpose.

## 8. Authentication security

- Strong password hashing algorithm with appropriate cost.
- Email verification.
- Password reset tokens are one-time and expire.
- HttpOnly/Secure/SameSite session cookies where applicable.
- CSRF protection for cookie sessions.
- Session revocation.
- MFA for super admins; customer MFA roadmap.
- Brute-force/login rate limits.
- Security event logging.

## 9. Authorization failures

Return safe 403/404 behavior without leaking existence of another tenant's resources. Log enough internal context to investigate without exposing it to the caller.

## 10. AI security

AI outputs are untrusted input to the application.

Controls:

- Structured output validation.
- Tool/capability allowlist.
- Server-side validation of all mutations.
- Prompt/data boundaries prevent cross-tenant context.
- Do not inject secrets into prompts unless absolutely required.
- Avoid storing full system prompt/provider payloads in broad-access logs.
- Prompt-injection-resistant design: retrieved documents/user messages cannot grant new tools or override server authorization.
- Human handoff for uncertain/high-risk transactional cases according to business policy.

## 11. Dynamic collection security

Customer-defined schemas are metadata, not SQL. Field keys/labels/filters are never interpolated into raw SQL without safe mapping/parameterization.

Validation rules have complexity limits to prevent abusive schemas or expensive queries.

## 12. Rate limits and abuse prevention

Apply limits to:

- authentication attempts
- API requests
- media uploads
- webhook/event volume where appropriate
- AI calls
- outbound messaging
- training jobs
- imports/exports

Tenant plan limits complement, not replace, security rate limits.

## 13. Audit logs

Audit at minimum:

- tenant/member/role changes
- channel connect/disconnect/credential replacement
- AI provider credential changes
- prompt publish/rollback
- training auto-publish changes
- plan/limit changes
- order/booking corrective admin edits
- exports/deletion
- super-admin impersonation/support access
- queue recovery/destructive actions

Audit records are append-oriented and protected from normal tenant modification.

## 14. Application logging

Structured logs should include:

- timestamp
- service
- environment
- severity
- correlation/request/job ID
- tenant/business/channel IDs when appropriate
- error code/category
- duration

Never log:

- full access tokens/API keys
- passwords/reset tokens
- unredacted authorization headers
- unnecessary full message/media contents

## 15. Backup strategy

### PostgreSQL

- Automated scheduled backups.
- Point-in-time recovery if feasible for production.
- Backup encryption.
- Off-machine/off-volume copy.
- Periodic restore tests.

### Media storage

- Backup/replication strategy for persistent customer assets.
- Document RPO/RTO.
- Reconciliation between database metadata and stored objects.

### Redis

Redis is not the canonical source of truth. Persistence may improve recovery, but system correctness cannot depend on Redis being the only copy of important state.

### n8n

Back up n8n database and workflow exports/configuration according to deployment policy.

## 16. Recovery objectives

Define production targets before launch:

- RPO: maximum acceptable durable data loss.
- RTO: target service recovery time.
- Queue recovery behavior.
- Media recovery behavior.
- Webhook replay/manual reconciliation procedure.

## 17. Failure modes

### PostgreSQL unavailable

- Reject state-changing operations safely.
- Do not acknowledge durable webhook processing if event was not safely recorded according to ingest design.
- Alert operators.

### Redis unavailable

- Fail/enqueue through durable fallback where designed.
- Do not lose persisted business state.
- Degrade rate-limited features safely.

### Media storage unavailable

- Text-only flows may continue if business policy allows.
- Media sends/uploads queue/retry.
- Do not lose metadata references.

### AI provider unavailable

- Apply configured fallback only if allowed.
- Otherwise safe error/handoff.
- Do not duplicate transactional actions on retry.

### Meta/provider unavailable

- Queue bounded retries.
- Respect retry-after.
- Surface backlog/failure to admin/customer as appropriate.

### n8n unavailable

- Application panels remain available for management where possible.
- Incoming events are durably accepted/queued only if ingest path supports it.
- Operators see automation outage.

## 18. Database migrations

- Version-controlled migrations only.
- Backup/recovery consideration for destructive changes.
- Expand/migrate/contract patterns for zero/low downtime.
- Workers/n8n must tolerate compatible schema during rolling deployment.
- Never manually edit production tables without audited emergency procedure.

## 19. Privacy and retention

Define configurable/default retention for:

- conversations/messages
- raw webhook payloads
- media attachments
- training examples
- AI provider request metadata
- audit logs
- usage events

Tenant deletion must respect retention/legal policy while revoking access immediately according to product rules.

## 20. Data export/deletion

Provide controlled customer export/deletion workflows in later product phases. Exports are authenticated, audited, time-limited, and never contain decrypted provider secrets.

## 21. Observability/security alerts

Alert on:

- repeated auth failures
- tenant-isolation error signals
- webhook signature failures spike
- queue backlog/dead-letter growth
- database/Redis/media/n8n outage
- AI cost anomaly
- provider auth failures/reconnect spike
- backup failure
- worker heartbeat loss

## 22. Reliability patterns

- Idempotency keys.
- Database unique constraints.
- Transactional outbox.
- Bounded retries with backoff/jitter.
- Dead-letter queues.
- Distributed locks plus DB constraints/versioning.
- Circuit-breaker/degraded behavior where appropriate.
- Health/readiness checks.
- Graceful shutdown of workers so active jobs are not abandoned incorrectly.

## 23. Acceptance criteria

Security/reliability is not complete until:

- tenant escape tests fail closed
- secrets cannot be retrieved from normal logs/read APIs
- duplicate webhooks/actions remain idempotent
- backup restoration is demonstrated
- worker/Redis restart does not lose durable business state
- privileged admin actions are auditable
- failure of AI/Meta/media services produces bounded, observable degradation rather than silent corruption