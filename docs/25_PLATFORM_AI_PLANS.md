# Platform-managed AI and monthly package allowances

The SaaS uses platform-managed AI. Customer workspaces do **not** provide AI API keys and do **not** choose provider model IDs.

## Ownership boundary

Super Admin owns:

- AI provider credentials;
- approved task model routes;
- model fallback priority;
- credit weighting per model;
- Free/Pro package limits;
- tenant plan assignment and optional tenant-specific limit overrides.

Customers own:

- businesses and connected social channels;
- business data and knowledge;
- AI agents, prompts, training examples and channel-agent assignment;
- consumption of the monthly AI allowance included in their package.

## Platform model routes

Super Admin configures global routes for these task keys:

- `DEFAULT_CHAT`
- `INTENT_CLASSIFICATION`
- `IMAGE_ANALYSIS`
- `AUDIO_TRANSCRIPTION`
- `STRUCTURED_EXTRACTION`
- `PROMPT_SYNTHESIS`
- `EMBEDDINGS`

Each route stores a provider/model, priority, provider parameters and credit weighting:

- `requestCredits`
- `inputCreditsPer1kTokens`
- `outputCreditsPer1kTokens`

Runtime resolves platform routes by task and priority. Tenant/customer model configuration is not used for AI execution.

## Monthly tokens and credits

Each plan exposes two independent monthly ceilings:

- `monthlyAiTokens`: actual provider-reported input + output token usage;
- `monthlyAiCredits`: platform-weighted usage that can account for different model costs.

Credit calculation:

```text
credits = requestCredits
        + (inputTokens / 1000)  * inputCreditsPer1kTokens
        + (outputTokens / 1000) * outputCreditsPer1kTokens
```

The runtime checks both limits before new AI work. When either allowance is exhausted it returns a non-retryable plan-limit error (`AI_TOKEN_LIMIT_REACHED` or `AI_CREDIT_LIMIT_REACHED`).

The monthly allowance covers all platform AI work, including:

- conversation/chat generation;
- image analysis;
- audio transcription;
- RAG query embeddings;
- knowledge indexing embeddings;
- prompt synthesis/training;
- other task routes that emit usage events.

Usage is recorded in `usage_events` with `input_tokens`, `output_tokens`, `total_tokens`, and `credits`.

## Packages

Migration `009_platform_ai_plans.sql` seeds editable starter values:

| Package | Monthly AI tokens | Monthly AI credits |
| --- | ---: | ---: |
| Free | 100,000 | 100 |
| Pro | 2,000,000 | 2,000 |

These values are initial operational defaults, **not final commercial pricing**. Super Admin can change them from `/platform-ai` without implementing a payment flow.

New/legacy Starter workspaces are normalized to the Free package. Additional Pro-style plans can use the same `plans.limits` keys.

## Payment scope

Payment checkout, subscription charging, card collection and automatic renewals are intentionally out of scope for this phase. Plan assignment remains administrative/manual.

## UI

Super Admin:

```text
/platform-ai
```

- create/rotate platform provider credentials;
- discover provider models;
- configure task routes and credit weights;
- enable/disable model routes;
- edit monthly token/credit allowances for plans.

Customer:

```text
/usage
```

- view current plan;
- monthly tokens used / remaining;
- monthly credits used / remaining.

`/ai-models` is informational only and no longer exposes provider/model configuration.

## API boundary

Customer provider/model mutation endpoints are blocked with:

```text
403 PLATFORM_AI_MANAGED
```

The legacy Customer AI Agent screen may temporarily read an empty provider/model collection for UI compatibility, but it never receives platform secrets or platform route configuration.

Admin endpoints:

```text
GET    /v1/admin/platform-ai/providers
POST   /v1/admin/platform-ai/providers
PATCH  /v1/admin/platform-ai/providers/:providerId
POST   /v1/admin/platform-ai/providers/:providerId/test
GET    /v1/admin/platform-ai/providers/:providerId/catalog

GET    /v1/admin/platform-ai/models
POST   /v1/admin/platform-ai/models
PATCH  /v1/admin/platform-ai/models/:modelId
GET    /v1/admin/platform-ai/defaults

PATCH  /v1/admin/plans/:planId/ai-allowance
```

Customer allowance endpoint:

```text
GET /v1/tenants/:tenantId/ai/allowance
```
