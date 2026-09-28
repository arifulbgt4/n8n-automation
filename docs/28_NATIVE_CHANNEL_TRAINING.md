# Native channel training sessions

## Customer behavior

Training Studio selects an existing agent and one of its assigned channels. Turning training on creates one tenant-scoped session for the whole channel. AI replies and automated follow-ups are suppressed while the session is open; separate HUMAN and PAUSED conversation handoffs remain intact. Turning training off removes the channel suppression and starts prompt synthesis from all approved examples for that agent, including earlier sessions. The candidate is reviewable and never auto-published by this session flow. Publishing is a separate action.

Only customer messages and replies observed from the provider's original business inbox/app during the session are eligible. Customer Panel replies are operational human replies, not training demonstrations. Both sides of a pair must belong to the same conversation and the same session. Provider event time, not webhook arrival time, determines the session boundary. Text and media captions can form training examples; uncaptioned media is not converted into a text demonstration.

The application database owns the session and captured message records. The 20-message operational conversation cache is not the training dataset. Provider message IDs deduplicate callbacks. Late events inside a closed session update the examples; a candidate generated before those events is rejected at publish until a new candidate is generated with **Generate candidate**. Candidate publication compares the approved examples and native event counts with the synthesis snapshot. Tenant data export includes sessions, captured events, examples, and synthesis jobs. The configured training retention policy can expire older examples and sessions.

## Customer API

- `GET /v1/tenants/:tenantId/agents/:agentId/training-sessions?channelAccountId=:channelId` returns scoped session history, captured/example counts, the candidate job status, and the provider capability reason.
- `POST /v1/tenants/:tenantId/agents/:agentId/training-sessions` with `{ "channelAccountId": "..." }` verifies the channel's default agent and native reply capability, then turns training on.
- `POST /v1/tenants/:tenantId/agents/:agentId/training-sessions/:sessionId/stop` turns training off and queues a reviewable candidate only when that session produced approved examples. Repeating the request is safe.

The mutating endpoints require a tenant/business-scoped owner, admin, or staff session plus CSRF validation. A single open session is allowed per channel. The session status and provider capability are read-only to the Training Studio; no trainer identity is requested.

## Provider feasibility and training gate

| Channel | Documented native reply signal | Current gate |
| --- | --- | --- |
| Facebook Page Inbox | [`message_echoes` with Page Inbox `app_id=26390203743090`](https://developers.facebook.com/documentation/business-messaging/messenger-platform/webhooks/webhook-events/message-echoes) | Verify the Page's `message_echoes` subscription with Meta at session start. Other app echoes and known API outbounds are excluded. |
| Instagram | [`is_echo` identifies business outgoing messages](https://developers.facebook.com/documentation/instagram-platform/webhooks/examples), without a documented per-message native-app source marker | Unavailable until a reliable message-level native source signal is demonstrated. `is_echo` alone is never treated as human training evidence. |
| WhatsApp Business App | [`smb_message_echoes` describes Business App/linked-device sends](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes) | Parser exists, but Training ON remains unavailable until [Coexistence onboarding](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users), provider status and webhook subscription are verified for this app/account. Ordinary Cloud API credentials do not establish this capability. |

Local checks include a real PostgreSQL 17 migration, PostgreSQL/Redis-backed API ON/OFF and webhook tests, native-echo fixtures, AI enqueue suppression, cumulative sessions, and stale-candidate rejection. These tests stub Meta's Page subscription response. A channel must not be shown as training-capable based on synthetic fixtures alone; the live Page subscription is checked again when Training ON is requested.

On 2026-09-29, application revision `917cfac` was deployed to the VPS, followed by `cbe2f84` to handle out-of-order customer webhooks after native replies. The current API, worker, and Customer Panel images use `cbe2f84`. Migration `016_native_channel_training.sql` is applied. The API, worker, panel, public API readiness route, and panel API proxy were healthy. Both connected Facebook Pages passed live Meta app-token and `message_echoes` subscription checks, and the assigned Page passed the application's native-training capability check. A signed, empty Page webhook returned HTTP 200 with zero events; the unsigned equivalent returned HTTP 401. This verifies public routing and signature enforcement without creating customer messages.

The VPS database currently has two connected Facebook Pages, one assigned to an agent, and no connected Instagram or WhatsApp channels. A real customer message followed by a reply from the original Page Inbox has **not** been exercised on a designated test-safe Page, so end-to-end provider message capture and AI suppression during a live session remain **SKIPPED**. Instagram native attribution and WhatsApp Business App Coexistence remain **SKIPPED** for the stated capability and account prerequisites.

## Verification matrix

For each channel, send an authorized customer message and replies from the original business app, Customer Panel, this app's API, and any other connected API app. Record the webhook's account, contact, message ID, provider timestamp, source field, and signature validation outcome. Confirm the original-app reply pairs with the correct customer and the other replies are excluded. Test automated native greetings separately: a native app marker by itself may not distinguish a person from a platform-generated greeting.

Test session boundary and state separately: pre-ON, during-ON, post-OFF, duplicate and delayed callbacks; queued AI and follow-up jobs; independent HUMAN/PAUSED handoffs; a second session reusing earlier examples; an empty session; candidate generation failure; late-event candidate invalidation; and cross-tenant/channel authorization. Report any provider test that cannot be run as **SKIPPED**, with the missing prerequisite.
