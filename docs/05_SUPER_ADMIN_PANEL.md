# Super Admin Panel specification

## 1. Purpose

`super-admin-panel` is the platform operator console. It controls platform-level configuration and provides visibility across tenants, businesses, channels, usage, automation health, queues, AI consumption, failures, plans, and security/audit events.

It is not a normal tenant panel with extra UI. Authorization, session policy, auditing, and destructive-action controls are stricter.

## 2. Primary navigation

Proposed sections:

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

Show platform health and risk indicators:

- Active/suspended tenants.
- Connected channels by platform and status.
- Messages/AI turns/media volume over time.
- Delivery failure/retry/dead-letter rates.
- Queue depth/oldest job age.
- n8n workflow/integration health.
- Redis/PostgreSQL/media service status.
- AI provider error/cost summaries.
- Orders/bookings/leads across platform.
- Tenants nearing/exceeding limits.
- Reconnect-required Meta accounts.
- Recent security/audit alerts.

Dashboard values must be derived from metered/operational data, not expensive scans of raw messages on every page load.

## 4. Tenant management

Super admins can:

- Search/filter tenants.
- View tenant details, owners/members, businesses, channels, plan, usage, and health.
- Suspend/reactivate tenant with reason.
- Assign/change plan and explicit limit overrides.
- Inspect configuration errors.
- Trigger controlled diagnostics.
- Begin tenant deletion/retention workflow.
- View audit history.
- Use scoped support/impersonation tools if implemented.

Sensitive actions require confirmation and audit metadata.

## 5. User/member support

Admin tools may:

- View user status and tenant memberships.
- Re-send invitation/verification if product policy permits.
- Revoke sessions for security/support.
- Disable compromised accounts.
- Assist with ownership transfer through a safe workflow.

Admin must not view customer passwords or full credential secrets.

## 6. Business/channel operations

Cross-platform view of businesses and connected accounts:

- Tenant/business owner.
- Platform/external account identifiers.
- Connection/token status.
- Last webhook activity.
- Last successful outbound delivery.
- Assigned agent/data configuration.
- Current limits.
- Error state/reconnect requirement.

Admin can pause a problematic channel, force a safe connection test, invalidate caches, or request reauthorization. Direct secret display is prohibited.

## 7. Messaging operations

Platform operators need diagnostic visibility without turning the panel into an unrestricted privacy bypass.

Safe views should expose:

- Message/event counts.
- Delivery statuses/errors.
- Correlation IDs.
- Queue job references.
- Platform API error summaries.
- Conversation mode/state.

Full conversation content access should be permission-gated, audited, and limited to support need.

Admin actions may include:

- Retry eligible failed jobs.
- Cancel queued outbound jobs before dispatch when safe.
- Move poison messages/jobs to/from dead-letter recovery workflows.
- Pause outbound messaging for a tenant/channel.

## 8. Orders/business actions overview

Provide cross-tenant operational statistics and support views for orders/bookings/leads/quotes. Admin should not casually modify customer transactional data. Any corrective edit must be privileged, audited, and preferably go through the same application service/state-transition rules as customer edits.

## 9. AI provider/platform configuration

Platform may offer centrally managed AI providers. Admin can manage:

- Provider definitions.
- Encrypted platform credentials.
- Allowed model registry.
- Model aliases/defaults.
- Task capability metadata (vision, transcription, embeddings, etc.).
- Cost/token pricing metadata for estimates.
- Provider health and error rates.
- Tenant/plan access policies.

Customer BYOK connections remain tenant-scoped and are not exposed in full to admins.

## 10. Prompt/training operations

Admin can inspect system-level training health:

- Training job counts/errors/cost.
- Candidate-generation failures.
- Prompt versions by tenant only when support permission allows.
- Model/config used for synthesis.
- Auto-publish policy status.

Admin may disable a dangerous/broken platform template or training feature through feature flags.

## 11. Usage and cost control

Views:

- Usage by tenant/business/channel/provider/model.
- AI tokens/calls/cost estimates.
- Messaging and media volumes.
- Object storage consumption.
- Vector/embedding jobs.
- Queue/worker processing volume.
- High-cost tenants/anomalies.

Controls:

- Plan assignment.
- Limit overrides.
- Temporary emergency caps.
- Disable platform-paid AI for a tenant while preserving BYOK if policy allows.

## 12. Plans and feature flags

Plans should be data-driven rather than hard-coded throughout UI/workflows.

Plan capabilities may control:

- Number of businesses.
- Number of channel accounts.
- Team seats.
- Monthly messages/AI turns/tokens.
- Media storage.
- Training features.
- BYOK availability.
- Advanced analytics.
- Retention duration.
- Custom collections/field limits.

Feature flags allow staged rollout by platform, plan, tenant, or percentage cohort. Flag changes are audited.

## 13. Media operations

Admin views:

- Total storage by tenant.
- Processing failures.
- Missing/orphaned storage references.
- Remote Meta media cache success/reupload rate.
- Asset lifecycle/retention jobs.

Admin should not browse private tenant media without an authorized support reason.

## 14. n8n operations

Do not expose n8n database internals as customer data. Super Admin may show an integration health abstraction:

- Required workflow/version registered.
- Webhook health.
- Recent execution success/failure counts.
- Failed correlation IDs.
- Workflow compatibility/version status.
- Last heartbeat.

Deep n8n editor access remains an operator/developer tool outside normal customer access.

## 15. Queue/job operations

Show per queue:

- Waiting/active/delayed/retrying/failed/dead-letter counts.
- Oldest waiting job.
- Throughput.
- Worker heartbeats.
- Error groups.

Safe controls:

- Retry selected failed job.
- Retry an error group with limits.
- Pause/resume queue where supported.
- Cancel eligible jobs.
- Inspect sanitized payload metadata.

Never expose decrypted secrets in job payload viewers.

## 16. Infrastructure health

Read-only health summaries for:

- API
- PostgreSQL
- Redis
- Worker pools
- n8n
- Media storage
- AI providers
- Meta/webhook connectivity

Operational alerts should distinguish global outage from tenant configuration failure.

## 17. Audit/security console

Searchable audit events:

- Admin logins/MFA/session changes.
- Tenant suspension/reactivation/deletion.
- Role/member changes.
- Secret rotation/revocation.
- Channel connection changes.
- Plan/limit changes.
- Support impersonation.
- Data exports.
- Retry/recovery/destructive operations.

Security events and application audits may have different retention policies.

## 18. System settings

Platform-wide settings should be versioned/audited and scoped. Examples:

- Supported channel API versions.
- Global safe messaging ceilings.
- Default aggregation windows.
- Media size/type limits.
- Allowed AI providers/models.
- Default retention policies.
- Training safety/auto-publish restrictions.
- Feature rollout flags.

Avoid a single unstructured settings JSON for everything; use typed settings/contracts for critical controls.

## 19. Dangerous operations

The following require explicit confirmation and often re-authentication:

- Tenant deletion.
- Bulk outbound retry.
- Global messaging pause/resume.
- Platform AI credential replacement.
- High-impact plan/limit changes.
- Data export of sensitive content.
- Support impersonation.
- Queue purge/dead-letter destructive cleanup.

## 20. Acceptance criteria

The super-admin panel is production-ready only when operators can diagnose tenant/channel/queue/AI failures without database shell access for normal incidents, while all privileged actions remain permission-controlled and auditable.