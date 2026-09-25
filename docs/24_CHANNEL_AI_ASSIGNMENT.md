# Channel AI agent assignment and conversation recovery

A connected social channel is transport-only until an active AI agent is selected for it. Facebook/Instagram OAuth success, Page webhook subscription, and a connected channel do not by themselves choose an AI agent.

## Runtime selection

New inbound conversations inherit `channel_accounts.default_agent_profile_id`. The selected agent must belong to the same tenant/business, have `status='active'`, and have an active prompt version.

AI response generation also requires a resolvable active `DEFAULT_CHAT` model configuration backed by an active AI provider connection.

## Customer setup order

1. Connect and test the Facebook/Instagram/WhatsApp channel.
2. Add an AI provider connection.
3. Open Customer Panel → **AI provider models** (`/ai-models`). Select the provider, load the model catalog exposed to that provider API key, choose or manually enter a provider model ID, and save a `DEFAULT_CHAT` route. `DEFAULT_CHAT` is tested against the provider before the route is saved.
4. Create an AI agent. Agent creation publishes an initial prompt version automatically.
5. Open Customer Panel → **AI Channel Setup** (`/channel-ai`).
6. Select the default agent for the channel and save.
7. Send a new customer message and verify the conversation/outbound delivery.

## Provider model discovery

The model identifier is owned by the AI provider; the SaaS does not invent a model ID. The discovery page calls:

```text
GET /v1/tenants/:tenantId/ai/providers/:providerId/catalog
```

The API retrieves the available model catalog using the provider credential already stored by the SaaS. It supports OpenAI, Anthropic, Gemini, and OpenAI-compatible providers. OpenAI-compatible providers can still use a manually entered model ID when their `/models` endpoint is unavailable or incomplete.

No provider API key is returned to the browser. The browser receives only model catalog metadata such as the model ID, display label, owner, or supported methods when the upstream provider supplies them.

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
No DEFAULT_CHAT model is configured for this agent.
```

Configure a provider/model route instead of treating that as a Meta or n8n webhook failure.

## n8n multimodal parser compatibility

The final workflow bundle avoids inline callback/arrow-function expressions in the Multimodal Preflight Set node. Some n8n runtime expression parsers report those expressions as `invalid syntax` and yield `undefined`. The workflow now uses callback-free string inspection for the image/audio presence summary while the API remains authoritative for actual multimodal processing.
