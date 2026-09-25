# Meta channel onboarding and Page webhook subscription

This document describes the production connection flow for Facebook Pages and Instagram professional accounts connected through Facebook Login.

## 1. One platform Meta App, many customer Pages

The SaaS uses one platform-owned Meta App. Each tenant customer authorizes that app with their own Facebook account and selects a Page they manage. The backend stores the resulting Page access token as an encrypted channel credential scoped to the selected tenant/business/channel.

Customers do not create their own Meta App for normal onboarding.

## 2. Required runtime configuration

The API requires:

```text
META_APP_ID=<platform Meta App ID>
META_APP_SECRET=<platform Meta App secret>
META_OAUTH_REDIRECT_URI=https://<api-host>/v1/channels/meta/oauth/callback
META_VERIFY_TOKEN=<shared Meta webhook verification token>
META_GRAPH_API_VERSION=<pinned Graph API version>
```

The public Meta webhook callback is:

```text
https://<api-host>/webhooks/meta
```

Raw Meta callbacks terminate at the SaaS API, not n8n.

## 3. App-level webhook configuration

App-level webhook configuration is performed once for the platform Meta App in Meta Developer configuration. The callback URL and verify token must point to the SaaS API `/webhooks/meta` endpoint.

The application must have the webhook fields needed by the runtime enabled at the app level. The current runtime consumes:

```text
messages
message_deliveries
message_reads
message_echoes
```

`messages` drives inbound customer messages. Delivery/read events update outbound delivery state. `message_echoes` is used to observe replies sent directly from the Page/Meta inbox so conversations can move to HUMAN mode when appropriate.

App-level webhook configuration and per-Page app subscription are separate requirements. Configuring the callback once does not automatically subscribe every customer Page.

## 4. Customer OAuth connection flow

The Customer Panel starts OAuth through:

```text
GET /v1/tenants/:tenantId/channels/meta/oauth/start
```

For Facebook, the platform requests the Page permissions needed to discover/manage the Page and use Messenger. For Instagram with Facebook Login, the linked professional account is discovered from the Facebook Page.

The callback exchanges the OAuth code, requests a longer-lived user token when available, then loads managed Pages from Meta `/me/accounts` including Page access tokens and linked Instagram professional-account metadata.

The discovery state is short-lived and bound to the authenticated SaaS user, tenant, and business.

## 5. Automatic `subscribed_apps` behavior

When the customer chooses a Page/account and completes the connection, the backend now automatically ensures the platform Meta App is subscribed to that Facebook Page through:

```text
POST /{page-id}/subscribed_apps
```

with the selected Page access token and these `subscribed_fields`:

```text
messages,message_deliveries,message_reads,message_echoes
```

The helper first inspects `GET /{page-id}/subscribed_apps`. If the platform app is already present with the required fields, no mutation is performed. Otherwise the backend performs the POST and verifies that the platform app is present afterward.

The Graph request uses the Page access token in the `Authorization: Bearer ...` header. Tokens are never returned in subscription diagnostics or error details.

## 6. Connection is not considered successful without webhook subscription

For the OAuth connection flow, Page subscription happens before the channel is persisted as connected.

If Meta rejects the Page subscription because of missing permissions, insufficient Page administration rights, business two-factor-authentication requirements, invalid/expired tokens, or another provider error, the API returns:

```text
META_PAGE_SUBSCRIPTION_FAILED
```

and does not create a channel that falsely appears connected.

Successful OAuth-created channels store non-secret subscription metadata in `settings_json`, including the Facebook Page ID, app ID, subscribed fields, and verification timestamp.

## 7. Test and reconnect are self-healing

`POST /v1/tenants/:tenantId/channels/:channelId/test` and the reconnect path verify both:

1. the channel token can access the Meta account; and
2. the Facebook Page is subscribed to the platform Meta App.

If the subscription is missing or its fields drift, the test/reconnect flow attempts to repair it automatically. A channel is marked degraded when identity access succeeds but webhook subscription cannot be established.

For Instagram channels connected through Facebook Login, `settings_json.facebookPageId` is used because the Page access token and owning Facebook Page are the subscription boundary used by this integration.

## 8. Permissions and Meta review

The OAuth implementation requests the relevant Facebook/Instagram permissions from the platform Meta App. Production use with customer-owned Pages and messages from people who are not app-role testers requires the Meta App to have the appropriate approved/advanced access and production status required by Meta.

Automatic Page subscription does not bypass Meta App Review, Business Verification, access-level restrictions, or messaging-policy windows.

## 9. Operational diagnostics

When a Page connects successfully, the API response includes a `metaSubscription` result. The result contains only safe metadata:

```text
ok
subscribed
pageId
appId
requestedFields
subscribedFields
mutated
detail
provider error code/type/message when Meta returns one
```

It never contains the Page access token.

When diagnosing a customer Page that receives no messages, check in this order:

1. platform Meta App is in the expected production/access state;
2. app-level callback `/webhooks/meta` verifies successfully;
3. app-level webhook fields are enabled;
4. OAuth token includes required permissions;
5. `GET /{page-id}/subscribed_apps` lists the platform app;
6. channel is active/connected in SaaS;
7. API receives a valid signed Meta POST;
8. worker/n8n turn pipeline processes the persisted message.

## 10. Source files

Implementation:

```text
apps/api/src/meta-page-subscription.ts
apps/api/src/routes/channels.ts
apps/api/src/routes/webhooks.ts
```

Tests:

```text
apps/api/test/meta-page-subscription.test.mjs
```
