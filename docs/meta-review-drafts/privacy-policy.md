# Privacy Policy — DRAFT, NOT APPROVED FOR PUBLICATION

Effective date: **to be approved before publication**.

This draft covers the Automation SaaS customer application at `app.openmusk.store` and its related API. The proposed operator is **Ariful Islam**; whether the service is legally operated by Ariful Islam personally or by **Otask, Ltd** must be confirmed before publication. Privacy contact: **arifulbgt4@gmail.com** (approved by the user for this purpose).

## What the service processes

- Account and access information: account name, email, password hash, verification/reset records, membership roles, invitations, sessions, and security/audit records.
- Business configuration: workspace and business details, connected channel identifiers and settings, catalog items, knowledge, training examples, agent instructions, automation policies, and usage data.
- Channel communications: identifiers, names and available contact details of people who communicate with connected Facebook Pages, Instagram accounts or WhatsApp Business numbers; message text, timestamps, delivery status, attachments and related conversations.
- Media: uploaded or received files, file metadata and tenant ownership. The application stores file references in its database and file bytes in a shared Media Storage service, with tenant-scoped access and quota checks.
- Technical information needed to run and secure the service, including session cookies, a CSRF token, request/audit metadata, error and usage records. The customer panel also stores the CSRF token in browser local storage.

Workspace owners control the channels they connect and much of the business content. People messaging those channels may not have an Automation SaaS account.

## Why data is processed

The service uses this information to authenticate users; connect and operate selected channels; receive, display and send business messages; support optional AI-assisted responses and human handoff; manage business data and outcomes; meter usage; deliver service emails; troubleshoot incidents; prevent misuse; and handle export/deletion requests. Connected-channel data is not collected from every Facebook/Instagram/WhatsApp account: it is processed only in the context of a channel a workspace has connected and the permissions it granted.

## Service providers and disclosures

The implementation communicates with **Meta** for connected Facebook, Instagram and WhatsApp channel authorization, messages, media and delivery; **Resend** (or a configured email delivery webhook) for transactional email; a configured AI provider for enabled AI tasks; and the service's configured hosting, database, Redis, n8n and Media Storage systems. Authorized workspace members can access data according to their role and business scope. We do not claim that connected-channel data is sold or used for targeted advertising; if future operations change, this policy must be updated first.

The exact infrastructure provider list, processing locations, cross-border-transfer arrangements and provider-specific data retention remain to be verified and approved before publication.

## Security and access

The application uses tenant-scoped authorization, authenticated sessions, server-side storage credentials, encrypted/referenced channel credentials, and audit records for sensitive operations. No system can promise absolute security. Connected third-party platforms have their own policies and may keep their own copies of messages or media.

## Retention and deletion

Workspace owners may configure retention days for certain closed/archived conversations, training records, audit records and unreferenced media in Settings. If a value is unset, that category does not automatically expire under the current retention worker. A workspace deletion request suspends automation, removes associated Media Storage files, disconnects channels, revokes relevant sessions and marks the workspace deleted. **Other application database records are not automatically erased at that moment.** A later hard-delete is conditional on an explicitly configured `hard_delete_after_days` policy. Backup retention and any legally required preservation need an approved, published schedule. This draft therefore makes no promise of immediate or fixed-time complete erasure.

## Your choices and requests

A workspace owner can request a JSON export from Customer Panel → Settings → Data export & deletion. That export contains application records and media metadata, not the actual media file bytes. The owner can also request workspace deletion there using password reauthentication. For access, correction, export or deletion questions—including a person who messaged a connected business but has no Automation SaaS account—contact **arifulbgt4@gmail.com** with enough information to locate the relevant Page/channel and message without sending passwords or sensitive attachments. We will need to verify the requester and whether the business or another person also has relevant rights before acting. The operator's response workflow and timeframe require approval before this text is published.

Disconnecting a channel or removing the Meta app does not automatically delete historical application data; see the separate Data Deletion Instructions.

## Changes and contact

Material changes will be reflected on this page with an updated effective date. Privacy questions and requests: **arifulbgt4@gmail.com**.
