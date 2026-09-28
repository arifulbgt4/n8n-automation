# Meta App Review submission draft — Facebook Page messaging

Status: **working evidence packet, not ready to submit**. This document describes the code-backed Facebook Page use case and lists facts and evidence that a human operator must supply or verify in Meta's current review form. It is not a Privacy Policy, Terms of Service, proof of business ownership, or a claim that Meta has approved the app.

## 1. Exact use case and scope

The product is a multi-tenant customer panel at `https://app.openmusk.store`. A signed-in customer with `OWNER` or `ADMIN` access chooses a business, authorizes the platform Meta app with a Facebook account that manages a Page, selects a returned Page, and connects it as a channel for that business. The SaaS receives Page Messenger webhooks, displays conversations in its unified inbox, and lets the customer reply manually or use a configured AI agent. The app also observes delivery/read events and Page-inbox echoes to maintain conversation state. The platform does **not** need access to a customer's personal Facebook profile messages.

This draft requests only these Facebook Page permissions: `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, and `pages_read_engagement`. Instagram professional-account review, if pursued, has its own permission set and evidence. Do not claim that the four Facebook permissions alone approve Instagram or WhatsApp.

Evidence in source: `apps/api/src/routes/channels.ts` (OAuth start/callback, `/me/accounts`, Page selection), `apps/api/src/meta-page-subscription.ts` (Page subscription), `apps/api/src/routes/webhooks.ts` (signed Messenger webhooks and inbox persistence), `apps/api/src/routes/conversations.ts` (manual replies), `apps/worker/src/worker.ts` (Messenger Send API), and `customer-panel/components/CustomerApp.tsx` (customer UI).

## 2. Permission explanations to adapt into Meta's current form

Use the wording below only after a matching test Page and walkthrough have been verified. These are explanations of current implementation, not assertions that Meta has granted advanced access.

### `pages_show_list`

**Why needed:** After a customer selects **Connect Facebook Page**, the app calls `GET /me/accounts` and displays the Pages available to the authorizing Facebook account. The customer chooses one Page to connect to one of their SaaS businesses. Without the list, the customer cannot identify or select the intended Page.

**Where shown in video:** Business & Channels → selected business → Connect channel → Connect Facebook Page → Meta authorization → Choose Meta account modal with returned Page names → select the intended Page. Use only a test Page owned/managed by the reviewer test account.

**Data used:** Page ID/name and the selected Page access token. The Page token is stored server-side as an encrypted channel credential. The panel receives only non-secret Page selection metadata.

### `pages_manage_metadata`

**Why needed:** After the customer selects a Page, the API checks `GET /{page-id}/subscribed_apps`, adds the platform app if necessary with `POST /{page-id}/subscribed_apps`, and verifies subscription to `messages`, `message_deliveries`, `message_reads`, and `message_echoes`. Without this, the selected Page cannot reliably deliver Messenger events to the SaaS inbox. The channel is not saved as connected if subscription fails.

**Where shown in video:** Complete Page selection, then show the new channel's connected status and **Test** result/diagnostics. Show the Meta Page's app/webhook subscription in the developer dashboard if the reviewer asks for provider-side proof. Never display tokens or app secrets.

**Data used:** Page ID, app ID, subscribed field names and subscription status; the Page token is used server-side to authenticate the subscription request.

### `pages_messaging`

**Why needed:** A customer connects their Page so incoming Messenger messages from people contacting that Page appear in the business's unified inbox. The app receives signed Meta webhooks, stores scoped conversations, and sends a reply through `POST /{page-id}/messages` when a customer agent or configured automation answers. Delivery/read and Page-inbox echo events update message status and human-handoff state. It is not a personal-profile Messenger client.

**Where shown in video:** From a separate authorized test profile, message the test Page; show the inbound message in the SaaS Conversations view; switch to **Human takeover**, send a reply, then show the reply on Messenger and its delivery state in the panel. If demonstrating AI, first configure an active agent and show a real, successful response without exposing private customer data.

**Data used:** Page-scoped sender ID, message text or attachment metadata/content needed for the conversation, timestamps, delivery/read state, and outbound message IDs. Do not claim unsolicited/broadcast messaging or messaging outside Meta policy windows. Review actual follow-up behavior against current Meta policy before including it in this permission narrative or screencast.

### `pages_read_engagement`

**Why needed in this implementation:** The OAuth configuration includes this permission while the app discovers Page identity/linked account metadata and verifies the selected Page with Graph `?fields=id,name`. The current code does **not** implement reading Page comments, posts, reactions, or public engagement insights. The reviewer narrative must be narrow: Page identity/metadata needed to verify the customer-selected Page and distinguish it from other Pages.

**Review risk / decision:** Before submission, confirm in Meta's current permission documentation and a Graph test that the exact fields used by this app require `pages_read_engagement`. If they do not, remove this permission from the Business Login configuration and review request rather than making a broader false claim. Capture a successful request/response shape with non-secret test data as evidence if retained.

## 3. Reviewer walkthrough — executable with prepared test assets

This is a draft of the steps to paste into Meta's reviewer-instructions field. Replace every bracketed field before submission. Do not provide credentials in Git or this document.

1. Open `https://app.openmusk.store` and sign in with the dedicated reviewer customer account supplied through Meta's secure review field: `[REVIEWER CUSTOMER ACCOUNT — PROVIDE IN META ONLY]`.
2. Open **Businesses & Channels**. Select `[TEST BUSINESS NAME]`. The account must have `OWNER` or `ADMIN` access to this business.
3. Open **Channels** within that business, select **Connect channel**, then **Connect Facebook Page**.
4. In Meta's consent screen, sign in as the dedicated Facebook reviewer/test user `[TEST FACEBOOK USER — PROVIDE IN META ONLY]`, which has the required access to `[TEST PAGE NAME]`. Authorize the requested Page permissions for that Page.
5. After redirect to the customer panel, select `[TEST PAGE NAME]` in **Choose Meta account**, then click **Connect Facebook Page**. The new channel should be shown as connected. Press **Test** and observe the connection and subscription result.
6. From `[SEPARATE MESSENGER TEST USER]`, send `[SAFE SAMPLE MESSAGE]` to `[TEST PAGE NAME]`. Return to **Conversations** in the customer panel and open the new conversation.
7. Select **Human takeover**, enter `[SAFE SAMPLE REPLY]`, and send it. Show the response in the Messenger test conversation and, after provider delivery, the panel's message status.
8. Optional AI proof, only if configured and tested: configure an active agent for this channel, switch the test conversation to AI mode, send a second safe message, and show the resulting answer. Do not include an unverified AI claim in the submission.
9. If the reviewer asks how to disconnect, return to the business's channel list and use **Delete**. This removes stored channel credentials and stops processing; it does **not** by itself prove deletion of previously stored end-customer messages.

The OAuth callback configured in Meta must be `https://api.openmusk.store/v1/channels/meta/oauth/callback`. The app-level webhook is `https://api.openmusk.store/webhooks/meta`. Confirm these URLs against the deployed environment and Meta dashboard immediately before review.

## 4. Screencast capture plan and evidence

Record one continuous, unedited walkthrough per Meta's current form instructions, or separate videos if Meta requests them. Capture the URL bar and UI labels; mask all passwords, access tokens, Page tokens, personal user data, unrelated Pages, and admin secrets. Do not paste an unlisted public video link into Git.

Required frames:

1. Customer sign-in and business selection (business-owner authorization boundary).
2. Connect Facebook Page button, Meta consent, and Page picker (`pages_show_list`).
3. Selection complete; connected channel, **Test** result, and, if available, Page subscription (`pages_manage_metadata`).
4. Inbound test Messenger message and its appearance in the unified inbox (`pages_messaging`).
5. Manual reply from customer panel and received reply in Messenger (`pages_messaging`).
6. Page identity verification/Graph evidence for `pages_read_engagement` **only if actual permission need is confirmed**.
7. Optional disconnect/reconnect proof, without falsely calling it full historical-message deletion.

Prepare: one non-production SaaS tenant/business, one dedicated test Facebook Page with Page access granted to the test account, a separate Messenger sender, safe sample messages, and reviewer credentials delivered only through Meta's secure fields. Verify that the current access level permits the chosen users to complete the demo; Standard Access app-role restrictions can make non-role users fail before the app receives an OAuth code. Record the exact Meta error and stop if the test cannot complete.

## 5. Data-handling answers — verified facts vs. unresolved answers

**Source-backed facts usable in review answers:**

- OAuth is started by a signed-in business `OWNER`/`ADMIN`; state is short-lived and tied to the SaaS user, tenant and business. Discovery state expires after 15 minutes. (`channels.ts`)
- Selected Page access tokens are stored as encrypted server-side credentials; token values are not shown in the customer Page picker. (`channels.ts`)
- The public webhook verifies `X-Hub-Signature-256` with the Meta app secret in production before ingesting messages. (`webhooks.ts`)
- Contact IDs, conversation/message content, media references, timestamps and delivery state are persisted in tenant/business/channel-scoped application tables. (`webhooks.ts`, database schema)
- Customer owner can request workspace export; the current JSON export includes contacts, conversations and messages, plus media metadata, **not the media file bytes**. (`data-management.ts`, `worker.ts`)
- Customer owner can request workspace deletion. The deletion job disables the tenant/channel, revokes sessions and deletes active media files, but **does not immediately erase stored contacts, conversations, messages or all related business records**. A later whole-tenant hard delete is conditional on a configured `hard_delete_after_days` retention policy and maintenance execution; it is not an individual Messenger-contact deletion flow. (`data-management.ts`, `worker.ts`)
- Retention cleanup deletes closed/archived conversations older than a configured tenant policy. The policy may be unset; this is not a universal deletion schedule and does not resolve a current open conversation or individual Messenger participant request. (`platform-config.ts`, `worker.ts`)

**Submission blockers — do not invent answers:**

1. `[LEGAL ENTITY NAME]`, `[REGISTERED BUSINESS TYPE]`, `[REGISTRATION/JURISDICTION]`, `[BUSINESS ADDRESS]` and actual ownership documents. Supply only genuine documents through Meta's Business Verification flow. A developer-authored statement is not proof of registration.
2. `[PUBLIC PRIVACY POLICY URL]`, `[TERMS URL]`, lawful basis/consent notices, vendor disclosures, precise retention periods, backup retention and cross-border processing facts. These require business-owner decisions and confirmation against actual operations. The user approved `arifulbgt4@gmail.com` as the OpenMusk privacy/data-deletion contact, but a monitored request-handling process still needs confirmation.
3. **End-user data deletion:** The current tenant deletion endpoint is not a deletion method for one Facebook/Messenger contact. No per-contact erasure API or verified manual request-and-fulfillment process was found. Implement or establish an actual intake, identity verification, tenant/Page resolution, scoped deletion or legally justified exception workflow, audit trail, and backup/provider-copy disclosures before answering Meta's deletion questions. If Meta requires a callback or public data-deletion instructions URL in the current dashboard, publish and verify the mechanism it requests. Do not claim a direct Messenger-user delete option exists today.
4. `[REVIEWER TEST ACCOUNT]`, `[TEST PAGE]`, `[SECOND TEST SENDER]`, and `[VIDEO LINKS]`, provided through Meta's review flow, with no credentials or private messages in this repository.
5. Verify `pages_read_engagement` necessity and the precise permission fields in the active Business Login configuration; remove unnecessary access instead of exaggerating use.
6. Confirm app/business verification state, app security checks, advanced-access eligibility and the exact current Meta reviewer questions before pressing **Submit for review**. Submission is not equivalent to approval.

## 6. Stop conditions for the submitter

Do not submit if the Meta form would require a false statement about business identity, data deletion, privacy/retention, user access, permission use, or an unrecorded reviewer walkthrough. Do not add unrelated permissions to make the OAuth dialog appear to work. Approval for unrelated customer profiles remains dependent on Meta's review/access decision, not just a callback-code change.
