# Data Deletion Instructions — DRAFT, NOT APPROVED FOR PUBLICATION

These instructions are intended for Automation SaaS workspace owners **and** people whose messages were processed through a business's connected Facebook Page, Instagram account or WhatsApp Business number. Privacy/deletion contact: **arifulbgt4@gmail.com** (approved by the user for this purpose). Do not send passwords, access tokens, government IDs or other sensitive records in an initial email.

## If you own an Automation SaaS workspace

1. Sign in to `app.openmusk.store` and open **Settings → Data export & deletion**.
2. If you need a copy first, choose **Request export** and wait for the private JSON export to complete. It contains application records and media metadata, **not media file bytes**.
3. Choose **Request tenant deletion** and re-enter your password. The application verifies your owner role, password and workspace identifier; the request then suspends the workspace and queues deletion.
4. The worker removes associated files from Media Storage, disconnects the workspace's channels, revokes relevant sessions and marks the workspace deleted. This is **not currently an immediate hard-delete of every database row**. Any later database hard-delete depends on a configured retention policy, and backup retention has not yet been verified.

If you cannot sign in, or need a request beyond the available in-app controls, email **arifulbgt4@gmail.com**. Identify the workspace by name and the email used for the account; do not include a password. The operator must verify account ownership through a safe process before acting.

## If you messaged a connected business but have no Automation SaaS account

You can request review/deletion of data that Automation SaaS holds about your interaction by emailing **arifulbgt4@gmail.com**. Identify the business or Page/account you contacted, the channel (Facebook Messenger, Instagram or WhatsApp), and an approximate date of the conversation. Avoid including the full conversation or sensitive attachments in the first email. The operator will verify the request and identify the relevant workspace; access to business-owned records and other participants' data may require coordination with the connected business.

You may also contact the business directly about its own copy of the conversation. Removing the app from Facebook/Instagram settings or disconnecting a Page stops future authorized access but does not necessarily delete existing Automation SaaS records. Meta and the connected business may maintain their own copies, governed by their separate policies.

## What the current application does not guarantee

The source code does not establish a fixed complete-erasure deadline, backup purge schedule, or direct self-service deletion flow for non-account messaging participants. The operator must approve and operationalize those before this page is published or submitted as Meta's Data Deletion Instructions URL. Do not replace this statement with a promise until the system and process actually meet it.
