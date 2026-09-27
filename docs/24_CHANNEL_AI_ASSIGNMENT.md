# Channel AI agent assignment and conversation recovery

A connected social channel is transport-only until an active AI agent is selected for it. Facebook/Instagram OAuth success, Page webhook subscription, and a connected channel do not by themselves choose an AI agent.

## Runtime selection

New inbound conversations inherit `channel_accounts.default_agent_profile_id`. The selected agent must belong to the same tenant/business, have `status='active'`, and have an active prompt version.

AI response generation also requires an active platform-managed `DEFAULT_CHAT` model route backed by an active provider connection.

## Customer setup order

1. Super Admin configures and tests an active platform `DEFAULT_CHAT` route in the Super Admin Panel.
2. Connect and test the Facebook/Instagram/WhatsApp channel in the Customer Panel.
3. Create an AI agent. Agent creation publishes an initial prompt version automatically.
4. Open Customer Panel → **AI Channel Setup** (`/channel-ai`).
5. Select the default agent for the channel and save.
6. Send a new customer message and verify the conversation/outbound delivery.

## Provider model discovery

Super Admin discovers provider model IDs and configures task routes through the platform AI controls. Customer workspaces do not manage provider credentials or model IDs.

## Assignment API

The Customer Panel uses:

```text
PUT /v1/tenants/:tenantId/channels/:channelId/default-agent
```

Body:

```json
{
  "agentProfileId": "<agent UUID or null>",
  "backfillOpenConversations": true
}
```

When an agent is selected, the API:

- validates tenant/business ownership;
- requires an active agent with an active prompt;
- updates `channel_accounts.default_agent_profile_id`;
- ensures `agent_channel_links` contains the channel/agent link;
- optionally backfills existing open AI-mode conversations whose `agent_profile_id` is still null;
- records an audit event.

Backfill deliberately does not overwrite conversations that already have an explicit agent assignment.

## `AGENT_NOT_CONFIGURED`

If `/v1/internal/ai/respond` returns:

```text
409 AGENT_NOT_CONFIGURED
Conversation has no active AI agent/prompt.
```

first verify the channel default agent and the conversation's `agent_profile_id`. Assigning a default agent through `/channel-ai` with backfill enabled repairs open AI conversations that were created before the channel was configured.

After agent assignment, a missing model is reported separately as:

```text
409 AI_MODEL_MISSING
No active DEFAULT_CHAT model configuration is available.
```

Configure a platform provider/model route in the Super Admin Panel instead of treating that as a Meta or n8n webhook failure.

## n8n multimodal parser compatibility

The final workflow bundle avoids inline callback/arrow-function expressions in the Multimodal Preflight Set node. Some n8n runtime expression parsers report those expressions as `invalid syntax` and yield `undefined`. The workflow now uses callback-free string inspection for the image/audio presence summary while the API remains authoritative for actual multimodal processing.
