# Platform-managed AI and daily credit allowances

The SaaS uses platform-managed AI. Customer workspaces do **not** provide AI API keys and do **not** choose provider model IDs.

## Ownership boundary

Super Admin owns:

- AI provider credentials and approved task model routes;
- one global token-to-credit conversion rate;
- the daily AI credit allowance for Free and Pro;
- tenant plan assignment and optional tenant-specific daily-credit overrides.

Customers own businesses, connected channels, business data, agents, prompts, training examples, and agent/channel assignment. The Customer Panel shows credit use and limits only; token totals and token ceilings remain platform-internal.

## Platform model routes

Super Admin configures global routes for `DEFAULT_CHAT`, `INTENT_CLASSIFICATION`, `IMAGE_ANALYSIS`, `AUDIO_TRANSCRIPTION`, `STRUCTURED_EXTRACTION`, `PROMPT_SYNTHESIS`, and `EMBEDDINGS`. Each route stores its provider/model, priority, provider parameters, and active state. Admins can enable, disable, edit, and delete routes from `/platform-ai`.

All routes share the global `tokens_per_credit` setting stored in `platform_ai_settings`. The initial migration default is 1,000 tokens per credit. Super Admin can select a preset or enter a custom value from 0.000001 to 1,000,000,000; the saved rate has six decimal places and the API returns that persisted value. Per-route credit weights are retained in the legacy schema for compatibility, but are not used for new metering.

## Daily AI credits

Every metered platform AI operation records provider-reported total tokens and credits in `usage_events`. Credit usage is calculated as:

```text
credits = totalTokens / tokensPerCredit
```

Usage is accumulated per tenant from 00:00 UTC to the next 00:00 UTC. The API enforces the daily credit allowance before AI work and returns `AI_DAILY_CREDIT_LIMIT_REACHED` when it is exhausted. The daily allowance covers chat, image/audio work, embeddings, prompt synthesis/training, and other platform routes that record AI usage.

Training synthesis jobs that reach this limit stay queued and are delayed until shortly after the next UTC reset. They do not consume retry attempts while waiting, and the allowance is never bypassed.

The public customer allowance response includes the plan, period start, UTC reset time, credit limit, credits used, and remaining credits. It does not return token counts or token ceilings.

## Plans and defaults

The supported plans are Free and Pro. Starter and other legacy plan rows are inactive, and tenants assigned to a legacy/custom plan are normalized to Free.

Migration `018_daily_ai_credits.sql` defaults preserve the former monthly credit budget as a 30-day daily average:

| Plan | Daily AI credits | Previous monthly credit equivalent |
| --- | ---: | ---: |
| Free | 3.333333 | 100 |
| Pro | 66.666667 | 2,000 |

These are configurable operational defaults, not final commercial pricing. The global conversion defaults to 1,000 tokens per credit. Payment checkout, subscription charging, card collection, and automatic renewals remain out of scope; plan assignment is administrative.

## UI

Super Admin at `/platform-ai` can:

- create/rotate platform provider credentials and discover models;
- add routes and enable, disable, edit, or delete them;
- set the global tokens-per-credit conversion;
- change Free and Pro daily credit allowances.

Customer usage at `/usage` shows only the current plan, credits used today, daily credits remaining, and the UTC reset time. No separate Channel AI setup page exists; owners/admins select channels in an Agent create/edit form.

## API boundary

Customer provider/model mutation endpoints remain blocked with `403 PLATFORM_AI_MANAGED`. The guard uses matched route templates and decoded parameters, so percent-encoded tenant or agent IDs cannot bypass platform management or the daily allowance. Customer workspaces do not receive platform secrets or token totals, including in agent test responses.

Admin endpoints:

```text
GET    /v1/admin/platform-ai/settings
PATCH  /v1/admin/platform-ai/settings
GET    /v1/admin/platform-ai/providers
POST   /v1/admin/platform-ai/providers
PATCH  /v1/admin/platform-ai/providers/:providerId
POST   /v1/admin/platform-ai/providers/:providerId/test
GET    /v1/admin/platform-ai/providers/:providerId/catalog
GET    /v1/admin/platform-ai/models
POST   /v1/admin/platform-ai/models
PATCH  /v1/admin/platform-ai/models/:modelId
DELETE /v1/admin/platform-ai/models/:modelId
GET    /v1/admin/platform-ai/defaults
PATCH  /v1/admin/plans/:planId/ai-allowance
```

`GET /v1/admin/plans` returns only Free and Pro. Creating more plans is disabled. Customer allowance endpoint:

```text
GET /v1/tenants/:tenantId/ai/allowance
```
