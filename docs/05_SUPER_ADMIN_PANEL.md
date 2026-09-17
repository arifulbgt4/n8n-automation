# Super Admin Panel specification

## 1. Purpose

`super-admin-panel` is the platform operator console. It controls platform-level application configuration and provides visibility across tenants, businesses, channels, usage, automation health, queues, AI consumption, failures, plans, media integration, and security/audit events.

It is not a tenant panel with extra UI. Authorization, session policy, auditing, and destructive-action controls are stricter.

Infrastructure itself is managed separately; Super Admin surfaces safe application-level health/metadata rather than exposing raw infrastructure credentials/admin panels.

## 2. Primary navigation

- Platform Dashboard
- Customers / Tenants
- Businesses
- Channels
- Conversations / Messaging
- Orders / Business Actions
- AI & Providers
- Training / Prompt Operations
- Usage / Costs
- Plans / Limits
- Media
- n8n / Automation
- Queues / Jobs
- Infrastructure Health
- Feature Flags
- Audit / Security
- System Settings

## 3. Platform dashboard

Show:

- active/suspended tenants.
- connected channels by platform/status.
- messages/AI turns/media volume.
- delivery failure/retry/dead-letter rates.
- queue depth/oldest job age.
- expected vs deployed n8n workflow bundle health.
- application DB/Redis/Media Storage integration health.
- AI provider error/cost summaries.
- orders/bookings/leads.
- tenants nearing/exceeding limits.
- reconnect-required channels.
- recent security/audit alerts.

Use rollups/operational data, not expensive raw scans.

## 4. Tenant management

Super admins can:

- search/filter tenants.
- view owners/members/businesses/channels/plan/usage/health.
- suspend/reactivate with reason.
- assign/change plan and explicit limit overrides.
- inspect configuration errors.
- trigger safe diagnostics.
- begin deletion/retention workflow.
- view audit history.
- use scoped support/impersonation if implemented.

Sensitive actions require confirmation and audit metadata.

## 5. User/member support

Admin tools may re-send invitation/verification where permitted, revoke sessions, disable compromised accounts, and assist ownership transfer safely.

Admins never see passwords or full stored credential secrets.

## 6. Business/channel operations

Cross-platform view includes:

- tenant/business owner.
- platform/external account identifiers.
- connection status.
- last webhook/outbound activity.
- assigned agent/data.
- effective limits.
- reconnect/error state.

Safe actions may pause a channel, run connection test, invalidate application cache, or request reauthorization. Direct secret display is prohibited.

## 7. Messaging operations

Safe diagnostics expose:

- message/event counts.
- delivery statuses/errors.
- correlation IDs.
- queue job references.
- provider API error summaries.
- conversation mode/state.

Full conversation content access is permission-gated and audited.

Actions may retry eligible failed jobs, cancel eligible queued sends, recover dead-letter work, or pause outbound messaging for a tenant/channel.

## 8. Orders/business actions overview

Provide operational/support views for orders/bookings/leads/quotes. Corrective edits are privileged/audited and should use the same application service/state-transition rules as tenant edits.

## 9. AI provider/platform configuration

Admin can manage:

- platform provider definitions/credentials.
- allowed model registry/defaults/aliases.
- capability metadata.
- cost/token pricing metadata.
- provider health/error rates.
- tenant/plan access policies.

Customer BYOK connections remain tenant-scoped and masked.

## 10. Prompt/training operations

Show training jobs/errors/cost, candidate failures, model/config used for synthesis, prompt version support data when authorized, and auto-publish policy status.

Admin may disable broken platform templates/features through feature flags.

## 11. Usage and cost control

Views:

- usage by tenant/business/channel/provider/model.
- AI tokens/calls/cost estimates.
- messaging/media volumes.
- Media Storage bytes/quota by tenant.
- vector/embedding jobs.
- queue/worker processing volume.
- high-cost/anomalous tenants.

Controls include plans, limit overrides, emergency caps, and platform-paid AI disablement according to policy.

## 12. Plans and feature flags

Plan capabilities may control businesses, channels, seats, messages, AI turns/tokens, media storage, training, BYOK, analytics, retention, custom collections/fields, and worker priority tier.

Plans/flags are data-driven, versioned/audited, and rollout can be scoped by platform/plan/tenant/cohort.

## 13. Media operations

Media view should expose application-level storage integration, not raw filesystem/admin internals.

Show:

- tenant Media Storage account status.
- external media-user mapping ID (safe identifier only).
- configured SaaS plan storage quota vs observed storage usage.
- asset counts/bytes by tenant.
- private/public asset counts.
- processing failures.
- storage quota errors.
- missing/orphaned references.
- remote provider media-cache hit/reupload rate.
- asset lifecycle/retention jobs.

Safe actions may:

- run storage connectivity/usage check.
- rotate/reprovision a tenant media credential through the approved internal operation.
- disable media uploads for an affected tenant.
- retry eligible processing jobs.

Never show a full Media Storage bearer key or unrestricted private tenant media without authorized support reason.

## 14. n8n / Automation operations

Super Admin provides an abstraction over the existing n8n runtime; it is not an n8n editor replacement.

Show:

- expected workflow bundle version from application deployment.
- deployed bundle version.
- required workflow keys present/missing.
- n8n workflow IDs linked to deployment metadata.
- active/inactive state.
- API/event contract compatibility.
- webhook/heartbeat health.
- recent execution success/failure counts.
- failed correlation IDs.
- deployment/cutover timestamp.

Safe operator actions may include application-owned health refresh and deployment-state diagnostics. Deep workflow editing remains outside normal Super Admin.

Do not expose n8n database internals or credentials.

## 15. Queue/job operations

Show waiting/active/delayed/retrying/failed/dead-letter counts, oldest waiting job, throughput, worker heartbeats, and error groups.

Safe controls:

- retry selected failed job.
- bounded error-group retry.
- pause/resume queue if library supports it.
- cancel eligible jobs.
- inspect sanitized metadata.

No decrypted secrets in job viewers.

## 16. Infrastructure health

Read-only integration health summaries:

- SaaS API.
- application PostgreSQL connectivity/migration version.
- Redis client/queue connectivity.
- worker pools.
- n8n runtime/workflow bundle.
- Media Storage connectivity/quota checks.
- AI providers.
- Meta/webhook connectivity.

Distinguish global infrastructure outage from tenant-specific configuration failure.

## 17. Audit/security console

Searchable events include:

- admin login/MFA/session changes.
- tenant suspension/reactivation/deletion.
- role/member changes.
- secret rotation/revocation.
- channel changes.
- tenant Media Storage account/key lifecycle.
- plan/limit changes.
- support impersonation.
- data exports.
- queue recovery/destructive actions.
- n8n workflow bundle deployment/activation/rollback.

## 18. System settings

Examples:

- supported channel API versions.
- global safe messaging ceilings.
- aggregation windows.
- media size/type policy layered above storage service.
- allowed AI providers/models.
- retention defaults.
- training safety/auto-publish restrictions.
- feature rollout flags.

Use typed settings/contracts for critical controls.

## 19. Dangerous operations

Require explicit confirmation and often re-authentication:

- tenant deletion.
- bulk outbound retry.
- global messaging pause/resume.
- platform AI credential replacement.
- high-impact plan/limit changes.
- sensitive data export.
- support impersonation.
- queue destructive cleanup.
- tenant Media Storage user/file destructive deletion.
- workflow bundle production cutover/rollback where exposed through application tooling.

## 20. Acceptance criteria

Super Admin is production-ready only when operators can diagnose tenant/channel/queue/AI/media/workflow failures without normal use of database shells or raw infrastructure admin credentials, while privileged actions remain permission-controlled and auditable.