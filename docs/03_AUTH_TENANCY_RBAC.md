# Authentication, tenancy, and RBAC

## 1. Goals

Authentication must support secure SaaS signup/signin for customers and separately controlled access for platform super administrators. Authorization must guarantee that one tenant cannot access another tenant's data, media, credentials, conversations, usage, or automation configuration.

## 2. Customer authentication flows

Required flows:

- Sign up with email/password.
- Email verification.
- Sign in.
- Sign out/current-session revocation.
- Forgot password/reset password.
- Change password while authenticated.
- View/revoke active sessions.
- Account suspension/disabled-state handling.
- Invitation acceptance for tenant members.
- Customer MFA remains a roadmap item; platform administrators require TOTP MFA (or a one-time recovery code) before privileged access.

The implementation may later add social/OAuth login, but email/password must not be coupled to a specific provider choice in the domain model.

## 3. Session requirements

- Use secure, HttpOnly, same-site cookies for browser sessions unless a reviewed alternative is chosen.
- Rotate/revoke sessions after password reset, account disable, suspicious activity, or explicit logout-all.
- Protect state-changing requests against CSRF when cookie-based authentication is used.
- Session tokens/refresh tokens must not be logged.
- Short-lived elevated-action confirmation may be required for secret rotation, tenant deletion, billing changes, or admin impersonation.

### Authentication realms

Customer and platform-admin access are separate authentication realms. The
same email may have one credential in each realm, but each realm has its own
password hash, browser session audience, and password-reset token. Customer
sign-in always creates a `customer` session and never returns platform-admin
MFA state. Super Admin sign-in must explicitly use the `admin` realm; only an
`admin` session can satisfy `requirePlatformAdmin` or access platform-admin
MFA endpoints. A customer password reset therefore cannot change or revoke
the administrator credential/session.

## 4. Tenant model

A tenant is the top-level customer organization boundary. A tenant can contain multiple businesses and users.

```text
User A -----+
            +--> Tenant X --> Business 1
User B -----+             --> Business 2

User A -----------> Tenant Y --> Business 3
```

The domain must allow a user to belong to more than one tenant even if the initial UI exposes only one primary organization.

## 5. Tenant roles

Initial roles:

### `OWNER`

- Full tenant administration.
- Manage members/roles.
- Manage businesses/channels.
- Manage AI/provider credentials.
- Manage plan/billing where enabled.
- Delete/close tenant subject to confirmation/retention rules.

### `ADMIN`

- Manage most tenant/business configuration.
- Cannot transfer ownership or perform restricted owner-only destructive/billing actions unless granted explicit permission.

### `STAFF`

- Operate inbox/conversations.
- Manage orders/bookings/leads according to permissions.
- May edit catalog/content if explicitly allowed.
- Cannot view provider API keys or platform secrets.

### `VIEWER`

- Read-only access to authorized dashboards/resources.

The model must be extensible to fine-grained permissions such as `channels.manage`, `catalog.write`, `conversations.takeover`, `ai.configure`, `billing.manage`.

## 6. Business-level access

A tenant member may eventually be restricted to selected businesses. Plan the schema/API so a membership can have:

- tenant-wide access, or
- explicit business assignments.

This allows a tenant with several brands to give staff access to only one brand.

## 7. Super-admin access

Super-admin privileges are platform-level and separate from tenant roles.

Suggested roles:

- `SUPER_ADMIN`: complete platform control.
- `SUPPORT_ADMIN`: tenant support/diagnostics with restricted destructive/secret capabilities.
- `BILLING_ADMIN`: plan/subscription/usage administration.
- `OPS_ADMIN`: infrastructure/job/workflow monitoring.

A super-admin identity must never be created merely by setting a tenant role string.

## 8. Super-admin authentication controls

Production-ready super-admin access should require stronger controls:

- MFA.
- Shorter idle timeout.
- Optional IP/network restrictions where practical.
- Audit log for every sensitive operation.
- Re-authentication for dangerous actions.
- No display of full customer AI/Meta secrets.

## 9. Admin impersonation / support access

If support impersonation is implemented:

- It must be explicit and time-limited.
- The banner/UI must clearly show impersonation state.
- The original admin actor must remain in every audit record.
- Secret viewing/export remains prohibited unless separately authorized.
- Customer-visible effects should be attributable to the support action.

Prefer scoped support views over unrestricted impersonation whenever possible.

The current repository permits only an MFA-verified, read-only support context through the `x-admin-tenant-access: support` header. It is represented as `VIEWER` access and is rejected for write methods or routes that require an owner/admin role; write-capable impersonation remains disabled until explicitly approved.

## 10. Authorization enforcement

Authorization is performed server-side for every operation. Hiding buttons in the UI is not authorization.

Every tenant-scoped request should establish an authorization context similar to:

```text
actor_user_id
actor_platform_role(s)
tenant_id
membership_role/permissions
business_scope
request/correlation_id
```

The service then verifies resource ownership before access.

## 11. Internal service authentication

n8n and workers require machine-to-machine authentication to internal API endpoints.

Requirements:

- Separate service identities/tokens from human sessions.
- Minimum required scopes.
- Rotation support.
- Never expose internal service tokens to browsers.
- Network-level restrictions where possible.
- All mutations still require explicit tenant/business identifiers and validation.

Example service scopes:

- `messaging.ingest`
- `messaging.send`
- `orders.create`
- `bookings.create`
- `ai.runtime.read`
- `usage.write`

## 12. Channel connection authorization

When a customer connects Facebook/Instagram/WhatsApp:

- OAuth/Meta permissions must be associated with the authenticated tenant/business.
- The callback must validate anti-CSRF state/nonce.
- The customer selects which available Page/account/number to connect.
- The backend stores only required tokens/metadata.
- A connection test is performed before status becomes active.
- Re-authentication/token expiry states are visible in the Customer Panel.

## 13. Secret access rules

Customer staff normally sees only whether a secret is configured and limited metadata such as provider name/key suffix. Full secret values are not returned after storage.

Only users with permission such as `ai_credentials.manage` can replace/revoke a BYOK credential.

## 14. Tenant isolation requirements

All of the following are tenant-isolated:

- Businesses
- Channels and credentials
- Collections/items
- Media assets and media mappings
- AI providers/agents/prompts/training
- Conversations/messages/contacts
- Orders/bookings/leads
- Usage/analytics
- Exports/imports
- Queue jobs and logs exposed in the UI
- Vector embeddings/retrieval

A resource ID alone must never authorize access. Tenant ownership must be checked.

## 15. Account lifecycle

### Customer user deletion

Removing a user does not automatically delete the tenant/business if other owners exist. Last-owner removal requires ownership transfer or tenant closure.

### Tenant suspension

Suspension should:

- Block customer login or restrict it to a suspension notice as policy dictates.
- Stop or pause outbound automations.
- Keep inbound webhook handling safe; events may be recorded/rejected according to policy.
- Preserve data until deletion/retention policy executes.

### Tenant deletion

Use a queued, auditable deletion workflow with a recovery/retention window if product policy allows. Revoke external credentials early in the process.

## 16. Security events

Record security-relevant events:

- Successful/failed login patterns.
- Password reset.
- Email change.
- MFA changes.
- Session revocation.
- Role/member changes.
- Secret creation/rotation/revocation.
- Channel connect/disconnect.
- Super-admin access/impersonation.
- Tenant suspension/deletion.

## 17. Acceptance criteria

Authentication/tenancy is not complete until tests prove:

- Tenant A cannot access Tenant B resources by guessing IDs.
- Business-restricted staff cannot access another business within the same tenant.
- Super-admin routes reject normal customer sessions.
- Revoked/suspended users lose access promptly.
- Internal service credentials cannot be used as customer browser sessions.
- Full secrets are not returned from read APIs or written to logs/audit payloads.
