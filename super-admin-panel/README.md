# Super Admin Panel

This application is the platform-operator UI for the n8n Automation SaaS.

## Planning status

The codebase is currently a Next.js application shell. Do not implement platform features until the repository planning documents are approved.

Canonical specification: [`../docs/05_SUPER_ADMIN_PANEL.md`](../docs/05_SUPER_ADMIN_PANEL.md).

## Planned responsibilities

- Separate platform-admin authentication and RBAC.
- Platform dashboard and health overview.
- Tenant/customer/user support and lifecycle management.
- Cross-tenant businesses and connected channel health.
- Plan, feature, and limit administration.
- AI provider/model registry and platform-managed credentials.
- Usage/cost/AI/media/messaging analytics.
- Queue, job, retry, and dead-letter diagnostics.
- n8n workflow/version/health monitoring.
- Redis/PostgreSQL/media/worker health summaries.
- Feature flags and system settings.
- Audit/security console.
- Controlled support/impersonation features if approved.

## Security rules

- Super-admin privileges are separate from tenant roles.
- Sensitive actions require explicit authorization and audit records.
- Full tenant AI/Meta secrets are never displayed in normal admin views.
- The UI calls the backend/API; it does not directly expose database, Redis, or n8n credentials to the browser.

Read the complete documentation starting at [`../docs/README.md`](../docs/README.md).