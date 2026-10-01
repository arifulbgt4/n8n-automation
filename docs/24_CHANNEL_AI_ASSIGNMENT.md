# Channel AI agent assignment and conversation recovery

A connected social channel is transport-only until an active AI agent is selected for it. Facebook/Instagram OAuth success, Page webhook subscription, and a connected channel do not by themselves choose an AI agent.

## Runtime selection

New inbound conversations inherit `channel_accounts.default_agent_profile_id`. The selected agent must belong to the same tenant/business, have `status='active'`, and have an active prompt version.

AI response generation also requires an active platform-managed `DEFAULT_CHAT` model route backed by an active provider connection.

## Customer setup order

1. Super Admin configures and tests an active platform `DEFAULT_CHAT` route in the Super Admin Panel.
2. Connect and test the Facebook/Instagram/WhatsApp channel in the Customer Panel.
3. Open Customer Panel → **AI Agents** and create or edit an agent for the business.
4. Select the connected channels that should use that agent. Saving makes it the channel's default agent and backfills open AI conversations that have no explicit agent assignment.
5. Select the data collections the agent should search. Collections also need the appropriate channel link in Data / Catalogs.
6. Send a new customer message and verify the conversation/outbound delivery.

Channel assignment is available only to tenant Owners and Admins, matching the existing channel-default-agent permission. A channel with Training ON cannot be reassigned. The former `/channel-ai` screen redirects to **AI Agents**; customers do not have to visit a separate setup page.

## Provider model discovery

Super Admin discovers provider model IDs and configures task routes through the platform AI controls. Customer workspaces do not manage provider credentials or model IDs.

## Agent-first assignment API

The Customer Panel uses the agent create and update APIs so channel and collection setup stay together:

```text
POST  /v1/tenants/:tenantId/agents
PATCH /v1/tenants/:tenantId/agents/:agentId
```

Both accept `channelIds`; PATCH applies the supplied list as the agent's selected channel defaults. The API validates tenant/business ownership, checks that each selected channel is not in an active training session, updates `channel_accounts.default_agent_profile_id` and `agent_channel_links`, and backfills open AI conversations with no explicit agent. Clearing a channel selection clears this agent as its default without overwriting conversations with an explicit assignment.

## Compatibility assignment API

The channel-scoped endpoint remains for older integrations:

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

first verify the channel default agent and the conversation's `agent_profile_id`. Assigning channels from AI Agents backfills open AI conversations created before the channel was configured. The legacy `/channel-ai` URL redirects to AI Agents.

After agent assignment from **AI Agents** (or the compatibility endpoint) a missing model is reported separately as:

```text
409 AI_MODEL_MISSING
No active DEFAULT_CHAT model configuration is available.
```

Configure a platform provider/model route in the Super Admin Panel instead of treating that as a Meta or n8n webhook failure.

## n8n multimodal parser compatibility

The final workflow bundle avoids inline callback/arrow-function expressions in the Multimodal Preflight Set node. Some n8n runtime expression parsers report those expressions as `invalid syntax` and yield `undefined`. The workflow now uses callback-free string inspection for the image/audio presence summary while the API remains authoritative for actual multimodal processing.
