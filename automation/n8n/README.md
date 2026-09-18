# n8n workflow bundle

These files are the version-controlled deployment artifacts for the already-running n8n runtime. They do not contain customer credentials, infrastructure hostnames, or installation logic.

## Required runtime environment

- `SAAS_API_INTERNAL_URL`: private/base URL of the SaaS API.
- `INTERNAL_SERVICE_AUTH_SECRET`: internal bearer secret shared with the SaaS API.
- `N8N_WORKFLOW_BUNDLE_VERSION`: should match `manifest.json`.

## Import and release process

1. Import all workflow JSON files while inactive.
2. Confirm the runtime environment values above.
3. Exercise each workflow in staging/manual mode and verify API correlation IDs.
4. Disable conflicting triggers from the previous bundle.
5. Activate the new workflows.
6. Configure the SaaS environment:
   - `N8N_TURN_WEBHOOK_URL` -> production URL of `saas-turn`.
   - `N8N_TRAINING_WEBHOOK_URL` -> production URL of `saas-training` when training is routed through n8n.
   - `N8N_HEALTH_WEBHOOK_URL` -> production URL of `saas-health`.
7. Verify the heartbeat appears in Super Admin before considering cutover complete.
8. Keep the previous bundle inactive during the observation window for rollback.

## Rollback

Deactivate the new bundle before reactivating an older bundle. Never leave two webhook/schedule bundles active on the same production channel. Application endpoints and business mutations are idempotent, but dual active triggers still create unnecessary load and can cause conflicting timing.

## Ownership

The JSON files and manifest in this directory are the source-of-record for SaaS n8n automation. Production-only editor changes must be exported back into Git before they are considered part of the application.
