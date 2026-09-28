# Meta review legal-page drafts — NOT APPROVED FOR PUBLICATION

These English drafts describe the current Automation SaaS implementation. They are **not legal advice**, are not linked from the customer panel, and must not be entered into the Meta dashboard until the operator approves the unresolved facts below and the public pages are deployed and checked.

User-provided candidate operator: **Ariful Islam**. The user approved **arifulbgt4@gmail.com** as the OpenMusk privacy/deletion contact. Meta's connected business portfolio is named **Otask, Ltd**; whether that is the legal operator of this SaaS is **not established**. Do not imply they are the same entity.

## Publication blockers

1. Confirm the legal operator (Ariful Islam as an individual, or a registered company), the correct legal name, operating country, and, where required, postal address. Reconcile this with the Meta business portfolio identity and submitted verification documents.
2. Establish a monitored request process for **non-account Meta users** whose messages reached a connected Page. The email above is approved for publication as the privacy/deletion contact; operational response ownership and response timeframe still need confirmation.
3. Decide and implement the deletion/retention schedule, including `hard_delete_after_days`, database records, backup copies, exports, provider copies, and legal holds. Today a workspace delete does **not** hard-delete all `app_db` rows immediately; see `apps/worker/src/worker.ts` (`tenant_delete` and `applyRetentionPolicies`).
4. Confirm actual infrastructure backup retention and subprocessors/hosting geography. Source code confirms PostgreSQL, Redis, Media Storage, n8n, Resend, Meta and configured AI providers; it does not establish the legal provider identities, geographic transfer locations, or exact backup retention.
5. Approve Terms decisions: commercial availability/pricing, payment/refund policy, legal venue, minimum age, liability/warranty limits, and effective date. Avoid stating terms not actually accepted in signup until acceptance is implemented.
6. Have the responsible operator review each final page for accuracy and compliance with applicable law. Then publish stable public HTTPS URLs, verify without authentication, and only then submit them to Meta.

## Technical evidence and cautions

- `/v1/tenants/:tenantId/export` creates an owner-only private JSON export. It includes workspace records and media metadata, **not media file bytes** (`apps/api/src/routes/data-management.ts`, `apps/worker/src/worker.ts`).
- `/v1/tenants/:tenantId/delete-request` requires an owner session, password reauthentication, and exact workspace slug. It immediately suspends the workspace and queues deletion. The worker deletes associated Media Storage files, marks the tenant deleted, disconnects channels, and revokes tenant-member sessions; application database records remain until a configured later hard-deletion policy removes them (`apps/api/src/routes/data-management.ts`, `apps/worker/src/worker.ts`).
- Per-workspace retention fields can be configured for closed/archived conversations, training data, audit logs and unreferenced media. Unset fields have no automatic expiration in this worker (`apps/api/src/routes/platform-config.ts`, `apps/worker/src/worker.ts`).
- End customers who message a connected Facebook/Instagram/WhatsApp business do not have an Automation SaaS login. The public deletion instructions must provide a path independent of workspace login. A plain email alone is not proof that the request was processed; the operator needs an identity/authority verification and completion procedure.
- Disconnecting the Meta app or a Page does not, by itself, erase existing SaaS records or copies held by Meta/other providers.
