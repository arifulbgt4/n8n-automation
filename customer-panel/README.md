# Customer Panel

This application is the tenant/customer-facing UI for the n8n Automation SaaS.

## Planning status

The codebase is currently a Next.js application shell. Do not implement product features until the repository planning documents are approved.

Canonical specification: [`../docs/04_CUSTOMER_PANEL.md`](../docs/04_CUSTOMER_PANEL.md).

## Planned responsibilities

- Customer signup/signin, verification, password/session management.
- Tenant/organization and team management.
- Multiple businesses per tenant.
- Facebook, Instagram, and WhatsApp connection/management.
- Dynamic Products / Services / Custom Collections and custom fields.
- Shared datasets across multiple channels with optional channel overrides.
- Unified conversations/inbox with AI/HUMAN handoff.
- Orders, bookings, leads, appointments, quotes, and capability-specific business actions.
- AI provider/BYOK configuration.
- AI agent profiles, prompts, versions, and channel assignments.
- Training Studio using trainer identities and simulated example conversations.
- Knowledge/RAG management.
- Media library backed by the OpenMusk/VPS media storage service.
- Messaging, AI, media, and follow-up limits.
- Per-channel usage/analytics and plan consumption.

## Architecture rules

- The UI talks to the SaaS backend/API; it does not access PostgreSQL, Redis, n8n admin APIs, or secret stores directly from the browser.
- `app_db` is the source of truth.
- Google Sheets are not part of the target system.
- All tenant-owned operations require server-side authorization.

Read the complete documentation starting at [`../docs/README.md`](../docs/README.md).