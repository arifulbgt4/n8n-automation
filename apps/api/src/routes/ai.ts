import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  enqueue,
  maskSecret,
  query,
  QUEUES,
  randomToken,
  sha256,
  transaction,
} from "@n8n-automation/core";
import { assertSafeAiBaseUrl, chat, testConnection, type AiConnection, type AiModelConfig } from "../ai-provider.js";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, requestId } from "../lib.js";

const providerSchema = z.enum(["openai", "anthropic", "gemini", "openai_compatible"]);
const taskKeys = ["DEFAULT_CHAT", "INTENT_CLASSIFICATION", "IMAGE_ANALYSIS", "AUDIO_TRANSCRIPTION", "STRUCTURED_EXTRACTION", "PROMPT_SYNTHESIS", "EMBEDDINGS"] as const;

async function loadProvider(tenantId: string, id: string) {
  const result = await query<AiConnection & { id: string; tenant_id: string; business_id: string | null; name: string; status: string }>(
    "SELECT id,tenant_id,business_id,name,provider,encrypted_api_key,base_url,status FROM ai_provider_connections WHERE id=$1 AND tenant_id=$2",
    [id, tenantId],
  );
  if (!result.rows[0]) throw new ApiError(404, "AI_PROVIDER_NOT_FOUND", "AI provider connection not found.");
  return result.rows[0];
}

async function loadAgent(tenantId: string, agentId: string) {
  const result = await query("SELECT * FROM agent_profiles WHERE id=$1 AND tenant_id=$2", [agentId, tenantId]);
  if (!result.rows[0]) throw new ApiError(404, "AGENT_NOT_FOUND", "AI agent not found.");
  return result.rows[0];
}

export async function aiRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/ai/providers", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId, ["OWNER","ADMIN"]);
    const result = await query(`
      SELECT id,tenant_id,business_id,name,provider,ownership_mode,key_hint,base_url,status,metadata,last_tested_at,created_at,updated_at
      FROM ai_provider_connections
      WHERE tenant_id=$1 AND ($2::uuid[] IS NULL OR business_id IS NULL OR business_id=ANY($2::uuid[]))
      ORDER BY created_at DESC
    `, [tenantId, context.membershipRole === "OWNER" ? null : context.businessScope ?? null]);
    reply.send({ providers: result.rows });
  });

  app.post("/v1/tenants/:tenantId/ai/providers", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid().nullable().optional(),
      name: z.string().trim().min(1).max(120),
      provider: providerSchema,
      apiKey: z.string().min(6),
      baseUrl: z.string().url().optional(),
      ownershipMode: z.enum(["BYOK", "PLATFORM"]).default("BYOK"),
    }).parse(request.body);
    if (input.provider === "openai_compatible" && !input.baseUrl) throw new ApiError(400, "BASE_URL_REQUIRED", "Base URL is required for OpenAI-compatible providers.");
    if (input.baseUrl) {
      try { input.baseUrl = await assertSafeAiBaseUrl(input.baseUrl); }
      catch (error) { throw new ApiError(400,"BASE_URL_UNSAFE",error instanceof Error ? error.message : "Unsafe base URL."); }
    }
    if (!input.businessId && context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A restricted administrator must select a business for this AI provider.");
    }
    if (input.businessId) {
      await requireBusinessAccess(request, tenantId, input.businessId, ["OWNER","ADMIN","STAFF"]);
      const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [input.businessId, tenantId]);
      if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    }
    const result = await query(`
      INSERT INTO ai_provider_connections(tenant_id,business_id,name,provider,ownership_mode,encrypted_api_key,key_hint,base_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,tenant_id,business_id,name,provider,ownership_mode,key_hint,base_url,status,created_at
    `, [tenantId, input.businessId ?? null, input.name, input.provider, input.ownershipMode, encryptSecret(input.apiKey), maskSecret(input.apiKey), input.baseUrl ?? null]);
    await audit({ actorUserId: principal.userId, tenantId, businessId: input.businessId ?? null, action: "AI_PROVIDER_CREATED", resourceType: "ai_provider_connection", resourceId: result.rows[0].id, safeDiff: { provider: input.provider, name: input.name }, request });
    reply.code(201).send({ provider: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/ai/providers/:providerId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), providerId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({ name: z.string().trim().min(1).max(120).optional(), apiKey: z.string().min(6).optional(), baseUrl: z.string().url().nullable().optional(), status: z.enum(["active", "invalid", "disabled"]).optional() }).parse(request.body);
    if (Object.prototype.hasOwnProperty.call(input, "baseUrl") && input.baseUrl) {
      try { input.baseUrl = await assertSafeAiBaseUrl(input.baseUrl); }
      catch (error) { throw new ApiError(400, "BASE_URL_UNSAFE", error instanceof Error ? error.message : "Unsafe base URL."); }
    }
    const current = await loadProvider(params.tenantId, params.providerId);
    if (current.business_id) {
      await requireBusinessAccess(request, params.tenantId, current.business_id, ["OWNER", "ADMIN"]);
    } else if (context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A restricted administrator cannot modify a tenant-wide AI provider.");
    }
    const result = await query(`
      UPDATE ai_provider_connections SET name=COALESCE($3,name),
        encrypted_api_key=CASE WHEN $4::boolean THEN $5 ELSE encrypted_api_key END,
        key_hint=CASE WHEN $4::boolean THEN $6 ELSE key_hint END,
        base_url=CASE WHEN $7::boolean THEN $8 ELSE base_url END,
        status=COALESCE($9,status),updated_at=now()
      WHERE id=$1 AND tenant_id=$2
      RETURNING id,tenant_id,business_id,name,provider,ownership_mode,key_hint,base_url,status,updated_at
    `, [params.providerId, params.tenantId, input.name ?? null, Boolean(input.apiKey), input.apiKey ? encryptSecret(input.apiKey) : null, input.apiKey ? maskSecret(input.apiKey) : null, Object.prototype.hasOwnProperty.call(input, "baseUrl"), input.baseUrl ?? null, input.status ?? null]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: current.business_id, action: "AI_PROVIDER_UPDATED", resourceType: "ai_provider_connection", resourceId: params.providerId, safeDiff: { name: input.name, apiKeyReplaced: Boolean(input.apiKey), baseUrl: input.baseUrl, status: input.status }, request });
    reply.send({ provider: result.rows[0] });
  });

  app.post("/v1/tenants/:tenantId/ai/providers/:providerId/test", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), providerId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({ model: z.string().min(1).optional() }).parse(request.body ?? {});
    const provider = await loadProvider(params.tenantId, params.providerId);
    if (provider.business_id) {
      await requireBusinessAccess(request, params.tenantId, provider.business_id, ["OWNER", "ADMIN"]);
    } else if (context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A restricted administrator cannot test a tenant-wide AI provider.");
    }
    const test = await testConnection(provider, input.model ? { model: input.model, parameters: {} } : undefined);
    await query("UPDATE ai_provider_connections SET status=$2,last_tested_at=now(),updated_at=now() WHERE id=$1", [params.providerId, test.ok ? "active" : "invalid"]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: provider.business_id, action: "AI_PROVIDER_TESTED", resourceType: "ai_provider_connection", resourceId: params.providerId, safeDiff: { ok: test.ok }, request });
    reply.send(test);
  });

  app.get("/v1/tenants/:tenantId/ai/models", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId, ["OWNER","ADMIN"]);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const result = await query(`
      SELECT m.*, p.name AS provider_name, p.provider
      FROM ai_model_configs m
      JOIN ai_provider_connections p ON p.id=m.provider_connection_id
      WHERE m.tenant_id=$1
        AND ($2::uuid[] IS NULL OR
          (m.business_id IS NULL OR m.business_id=ANY($2::uuid[]))
          AND (m.agent_profile_id IS NULL OR EXISTS (SELECT 1 FROM agent_profiles a WHERE a.id=m.agent_profile_id AND a.tenant_id=$1 AND a.business_id=ANY($2::uuid[])))
          AND (m.channel_account_id IS NULL OR EXISTS (SELECT 1 FROM channel_accounts c WHERE c.id=m.channel_account_id AND c.tenant_id=$1 AND c.business_id=ANY($2::uuid[])))
          AND (p.business_id IS NULL OR p.business_id=ANY($2::uuid[])))
      ORDER BY m.created_at DESC
    `, [tenantId, scope]);
    reply.send({ models: result.rows });
  });

  app.post("/v1/tenants/:tenantId/ai/models", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid().nullable().optional(),
      agentProfileId: z.string().uuid().nullable().optional(),
      channelAccountId: z.string().uuid().nullable().optional(),
      providerConnectionId: z.string().uuid(),
      taskKey: z.enum(taskKeys),
      model: z.string().trim().min(1).max(160),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    if ((input.agentProfileId || input.channelAccountId) && !input.businessId) {
      throw new ApiError(400, "BUSINESS_SCOPE_REQUIRED", "An agent- or channel-scoped model configuration must select its business.");
    }
    if (!input.businessId && context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A restricted administrator must select a business for this AI model configuration.");
    }
    const provider = await loadProvider(tenantId, input.providerConnectionId);
    if (provider.business_id) await requireBusinessAccess(request, tenantId, provider.business_id, ["OWNER", "ADMIN"]);
    if (!provider.business_id && context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      // Tenant-wide providers are usable for a scoped business, but never for a tenant-wide config.
      if (!input.businessId) throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A restricted administrator must select a business for this AI model configuration.");
    }
    if (input.businessId) await requireBusinessAccess(request, tenantId, input.businessId, ["OWNER","ADMIN"]);
    if (provider.business_id && input.businessId !== provider.business_id) throw new ApiError(400,"PROVIDER_SCOPE_INVALID","AI provider scope must match the model business.");
    if (input.agentProfileId) {
      const agent = await loadAgent(tenantId,input.agentProfileId);
      await requireBusinessAccess(request,tenantId,agent.business_id,["OWNER","ADMIN"]);
      if (input.businessId && agent.business_id !== input.businessId) throw new ApiError(400,"AGENT_SCOPE_INVALID","Agent does not belong to the selected business.");
      if (!input.businessId && input.channelAccountId) {
        const channel = await query<{ business_id: string }>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [input.channelAccountId, tenantId]);
        if (channel.rows[0] && channel.rows[0].business_id !== agent.business_id) throw new ApiError(400, "MODEL_SCOPE_INVALID", "Agent and channel must belong to the same business.");
      }
    }
    if (input.channelAccountId) {
      const channel = await query<{business_id:string}>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2",[input.channelAccountId,tenantId]);
      if(!channel.rows[0]) throw new ApiError(404,"CHANNEL_NOT_FOUND","Channel not found.");
      await requireBusinessAccess(request,tenantId,channel.rows[0].business_id,["OWNER","ADMIN"]);
      if(input.businessId && channel.rows[0].business_id!==input.businessId) throw new ApiError(400,"CHANNEL_SCOPE_INVALID","Channel does not belong to the selected business.");
    }
    const result = await query(`
      INSERT INTO ai_model_configs(tenant_id,business_id,agent_profile_id,channel_account_id,provider_connection_id,task_key,model,parameters)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *
    `, [tenantId, input.businessId ?? null, input.agentProfileId ?? null, input.channelAccountId ?? null, input.providerConnectionId, input.taskKey, input.model, JSON.stringify(input.parameters)]);
    await audit({ actorUserId: principal.userId, tenantId, businessId: input.businessId ?? null, action: "AI_MODEL_CONFIG_CREATED", resourceType: "ai_model_config", resourceId: result.rows[0].id, safeDiff: { taskKey: input.taskKey, model: input.model }, request });
    reply.code(201).send({ modelConfig: result.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/agents", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional() }).parse(request.query);
    const result = await query(`
      SELECT a.*,
        pv.version AS active_prompt_version,
        (SELECT count(*)::int FROM agent_channel_links l WHERE l.agent_profile_id=a.id) AS channel_count,
        (SELECT count(*)::int FROM agent_collection_links l WHERE l.agent_profile_id=a.id) AS collection_count
      FROM agent_profiles a LEFT JOIN prompt_versions pv ON pv.id=a.active_prompt_version_id
      WHERE a.tenant_id=$1 AND a.status<>'archived' AND ($2::uuid IS NULL OR a.business_id=$2)
        AND ($3::uuid[] IS NULL OR a.business_id=ANY($3::uuid[]))
      ORDER BY a.created_at DESC
    `, [tenantId, q.businessId ?? null, scope]);
    reply.send({ agents: result.rows });
  });

  app.post("/v1/tenants/:tenantId/agents", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid(),
      name: z.string().trim().min(1).max(160),
      description: z.string().max(2000).optional(),
      capabilities: z.array(z.string().regex(/^[A-Z0-9_]+$/)).max(50).default([]),
      behaviorSettings: z.record(z.string(), z.unknown()).default({}),
      channelIds: z.array(z.string().uuid()).max(50).default([]),
      collectionIds: z.array(z.string().uuid()).max(50).default([]),
      templateKey: z.string().regex(/^[a-z0-9_-]+$/).max(100).optional(),
      initialPrompt: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    await requireBusinessAccess(request, tenantId, input.businessId, ["OWNER", "ADMIN", "STAFF"]);
    const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [input.businessId, tenantId]);
    if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    const template = input.templateKey
      ? await query<any>("SELECT key,capabilities,sections_json FROM prompt_templates WHERE key=$1 AND active=true",[input.templateKey])
      : { rows: [] as any[] };
    if (input.templateKey && !template.rows[0]) throw new ApiError(400,"AGENT_TEMPLATE_NOT_FOUND","Selected agent template is unavailable.");
    const defaultPrompt={ core_role: "You are a helpful business assistant. Use current business data and never invent unavailable facts." };
    const initialPrompt=input.initialPrompt ?? template.rows[0]?.sections_json ?? defaultPrompt;
    const capabilities=[...new Set([...(template.rows[0]?.capabilities ?? []),...input.capabilities])];
    const agent = await transaction(async (client) => {
      const created = await client.query(`
        INSERT INTO agent_profiles(tenant_id,business_id,name,description,capabilities,behavior_settings)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *
      `, [tenantId, input.businessId, input.name, input.description ?? null, capabilities, JSON.stringify(input.behaviorSettings)]);
      const prompt = await client.query(`
        INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,source,status,sections_json,assembled_prompt,created_by,published_by,published_at)
        VALUES ($1,$2,1,$3,'active',$4::jsonb,$5,$6,$6,now()) RETURNING id
      `, [tenantId, created.rows[0].id, input.templateKey ? "template" : "manual", JSON.stringify(initialPrompt), Object.entries(initialPrompt).map(([key,value])=>`## ${key.replace(/_/g," ")}\n${typeof value==="string"?value:JSON.stringify(value,null,2)}`).join("\n\n"), principal.userId]);
      await client.query("UPDATE agent_profiles SET active_prompt_version_id=$2 WHERE id=$1", [created.rows[0].id, prompt.rows[0].id]);
      for (const channelId of input.channelIds) {
        const channel = await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [channelId, tenantId, input.businessId]);
        if (!channel.rows[0]) throw new ApiError(400, "CHANNEL_SCOPE_INVALID", "Agent channel must belong to the same business.");
        await client.query("INSERT INTO agent_channel_links(agent_profile_id,channel_account_id,tenant_id) VALUES ($1,$2,$3)", [created.rows[0].id, channelId, tenantId]);
      }
      for (const collectionId of input.collectionIds) {
        const collection = await client.query("SELECT id FROM collections WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [collectionId, tenantId, input.businessId]);
        if (!collection.rows[0]) throw new ApiError(400, "COLLECTION_SCOPE_INVALID", "Agent collection must belong to the same business.");
        await client.query("INSERT INTO agent_collection_links(agent_profile_id,collection_id,tenant_id) VALUES ($1,$2,$3)", [created.rows[0].id, collectionId, tenantId]);
      }
      return created.rows[0];
    });
    await audit({ actorUserId: principal.userId, tenantId, businessId: input.businessId, action: "AGENT_CREATED", resourceType: "agent_profile", resourceId: agent.id, safeDiff: { name: input.name, capabilities, templateKey: input.templateKey ?? null }, request });
    reply.code(201).send({ agent });
  });

  app.get("/v1/tenants/:tenantId/agents/:agentId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const prompts = await query("SELECT * FROM prompt_versions WHERE agent_profile_id=$1 ORDER BY version DESC", [params.agentId]);
    const channels = await query("SELECT channel_account_id,settings_json FROM agent_channel_links WHERE agent_profile_id=$1", [params.agentId]);
    const collections = await query("SELECT collection_id,priority FROM agent_collection_links WHERE agent_profile_id=$1 ORDER BY priority DESC", [params.agentId]);
    reply.send({ agent, prompts: prompts.rows, channels: channels.rows, collections: collections.rows });
  });

  app.patch("/v1/tenants/:tenantId/agents/:agentId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ name: z.string().trim().min(1).max(160).optional(), description: z.string().max(2000).nullable().optional(), capabilities: z.array(z.string()).max(50).optional(), behaviorSettings: z.record(z.string(), z.unknown()).optional(), status: z.enum(["active", "draft", "archived"]).optional() }).parse(request.body);
    const result = await query(`
      UPDATE agent_profiles SET name=COALESCE($3,name),description=CASE WHEN $4::boolean THEN $5 ELSE description END,
        capabilities=COALESCE($6,capabilities),behavior_settings=CASE WHEN $7::jsonb IS NULL THEN behavior_settings ELSE behavior_settings || $7::jsonb END,
        status=COALESCE($8,status),updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *
    `, [params.agentId, params.tenantId, input.name ?? null, Object.prototype.hasOwnProperty.call(input, "description"), input.description ?? null, input.capabilities ?? null, input.behaviorSettings ? JSON.stringify(input.behaviorSettings) : null, input.status ?? null]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "AGENT_UPDATED", resourceType: "agent_profile", resourceId: params.agentId, safeDiff: input, request });
    reply.send({ agent: result.rows[0] });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/prompts", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ sections: z.record(z.string(), z.unknown()), source: z.enum(["manual", "training", "template", "migration"]).default("manual"), baseVersionId: z.string().uuid().nullable().optional() }).parse(request.body);
    if (input.baseVersionId) {
      const base = await query("SELECT id FROM prompt_versions WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3", [input.baseVersionId, params.tenantId, params.agentId]);
      if (!base.rows[0]) throw new ApiError(400, "PROMPT_BASE_SCOPE_INVALID", "The base prompt must belong to this agent.");
    }
    const latest = await query<{ version: number }>("SELECT COALESCE(max(version),0)::int AS version FROM prompt_versions WHERE agent_profile_id=$1", [params.agentId]);
    const version = (latest.rows[0]?.version ?? 0) + 1;
    const assembled = Object.entries(input.sections).map(([key, value]) => `## ${key.replace(/_/g, " ")}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`).join("\n\n");
    const result = await query(`
      INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,source,status,sections_json,assembled_prompt,base_version_id,created_by)
      VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8) RETURNING *
    `, [params.tenantId, params.agentId, version, input.source, JSON.stringify(input.sections), assembled, input.baseVersionId ?? agent.active_prompt_version_id ?? null, principal.userId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "PROMPT_VERSION_CREATED", resourceType: "prompt_version", resourceId: result.rows[0].id, safeDiff: { version, source: input.source }, request });
    reply.code(201).send({ prompt: result.rows[0] });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/prompts/:promptId/publish", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid(), promptId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    await transaction(async (client) => {
      const prompt = await client.query("SELECT id FROM prompt_versions WHERE id=$1 AND agent_profile_id=$2 AND tenant_id=$3 FOR UPDATE", [params.promptId, params.agentId, params.tenantId]);
      if (!prompt.rows[0]) throw new ApiError(404, "PROMPT_NOT_FOUND", "Prompt version not found.");
      await client.query("UPDATE prompt_versions SET status='archived' WHERE agent_profile_id=$1 AND status='active' AND id<>$2", [params.agentId, params.promptId]);
      await client.query("UPDATE prompt_versions SET status='active',published_by=$2,published_at=now() WHERE id=$1", [params.promptId, principal.userId]);
      await client.query("UPDATE agent_profiles SET active_prompt_version_id=$2,updated_at=now() WHERE id=$1", [params.agentId, params.promptId]);
      await client.query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,correlation_id,payload)
        VALUES ($1,'AGENT_PROMPT_PUBLISHED',$2,'agent_profile',$3,$4,$5::jsonb)`, [params.tenantId, agent.business_id, params.agentId, requestId(request), JSON.stringify({ promptVersionId: params.promptId })]);
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "PROMPT_PUBLISHED", resourceType: "prompt_version", resourceId: params.promptId, request });
    reply.send({ ok: true });
  });

  app.get("/v1/tenants/:tenantId/agents/:agentId/trainers", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const scopedAgent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, scopedAgent.business_id);
    const result = await query("SELECT id,business_id,channel_account_id,agent_profile_id,type,label,active,created_at FROM trainer_identities WHERE tenant_id=$1 AND agent_profile_id=$2 ORDER BY created_at DESC", [params.tenantId, params.agentId]);
    reply.send({ trainers: result.rows });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/trainers", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ channelAccountId: z.string().uuid().nullable().optional(), type: z.enum(["facebook_user", "whatsapp_number", "instagram_user", "panel_simulator"]), identifier: z.string().min(1).max(500).optional(), label: z.string().trim().max(120).optional() }).parse(request.body);
    if (input.type !== "panel_simulator" && !input.identifier) throw new ApiError(400, "TRAINER_IDENTIFIER_REQUIRED", "Trainer identifier is required.");
    if (input.channelAccountId) {
      const channel = await query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [input.channelAccountId, params.tenantId, agent.business_id]);
      if (!channel.rows[0]) throw new ApiError(400, "TRAINER_CHANNEL_INVALID", "Trainer channel does not belong to this business.");
    }
    const result = await query(`
      INSERT INTO trainer_identities(tenant_id,business_id,channel_account_id,agent_profile_id,type,identifier_hash,encrypted_identifier,label)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,business_id,channel_account_id,agent_profile_id,type,label,active,created_at
    `, [params.tenantId, agent.business_id, input.channelAccountId ?? null, params.agentId, input.type, input.identifier ? sha256(input.identifier) : null, input.identifier ? encryptSecret(input.identifier) : null, input.label ?? null]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "TRAINER_IDENTITY_CREATED", resourceType: "trainer_identity", resourceId: result.rows[0].id, safeDiff: { type: input.type, label: input.label }, request });
    reply.code(201).send({ trainer: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/agents/:agentId/trainers/:trainerId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),agentId:z.string().uuid(),trainerId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const agent=await loadAgent(params.tenantId,params.agentId);
    await requireBusinessAccess(request,params.tenantId,agent.business_id,["OWNER","ADMIN","STAFF"]);
    const input=z.object({
      active:z.boolean().optional(),
      label:z.string().trim().max(120).nullable().optional(),
      identifier:z.string().min(1).max(500).optional(),
      channelAccountId:z.string().uuid().nullable().optional(),
    }).parse(request.body);
    if(input.channelAccountId){
      const channel=await query("SELECT 1 FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3",[input.channelAccountId,params.tenantId,agent.business_id]);
      if(!channel.rows[0])throw new ApiError(400,"TRAINER_CHANNEL_INVALID","Trainer channel does not belong to this business.");
    }
    const row=await query<any>(`
      UPDATE trainer_identities SET
        active=COALESCE($4,active),
        label=CASE WHEN $5::boolean THEN $6 ELSE label END,
        identifier_hash=CASE WHEN $7::boolean THEN $8 ELSE identifier_hash END,
        encrypted_identifier=CASE WHEN $7::boolean THEN $9 ELSE encrypted_identifier END,
        channel_account_id=CASE WHEN $10::boolean THEN $11::uuid ELSE channel_account_id END,
        updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3
      RETURNING id,business_id,channel_account_id,agent_profile_id,type,label,active,created_at,updated_at
    `,[
      params.trainerId,params.tenantId,params.agentId,input.active??null,
      Object.prototype.hasOwnProperty.call(input,"label"),input.label??null,
      Boolean(input.identifier),input.identifier?sha256(input.identifier):null,input.identifier?encryptSecret(input.identifier):null,
      Object.prototype.hasOwnProperty.call(input,"channelAccountId"),input.channelAccountId??null
    ]);
    if(!row.rows[0])throw new ApiError(404,"TRAINER_NOT_FOUND","Trainer identity not found.");
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,action:"TRAINER_IDENTITY_UPDATED",resourceType:"trainer_identity",resourceId:params.trainerId,safeDiff:{active:input.active,label:input.label,identifierRotated:Boolean(input.identifier),channelAccountId:input.channelAccountId},request});
    reply.send({trainer:row.rows[0]});
  });

  app.delete("/v1/tenants/:tenantId/agents/:agentId/trainers/:trainerId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),agentId:z.string().uuid(),trainerId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN"]);
    requireCsrf(request);
    const agent=await loadAgent(params.tenantId,params.agentId);
    await requireBusinessAccess(request,params.tenantId,agent.business_id,["OWNER","ADMIN"]);
    const row=await query("DELETE FROM trainer_identities WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3 RETURNING id",[params.trainerId,params.tenantId,params.agentId]);
    if(!row.rows[0])throw new ApiError(404,"TRAINER_NOT_FOUND","Trainer identity not found.");
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,action:"TRAINER_IDENTITY_DELETED",resourceType:"trainer_identity",resourceId:params.trainerId,request});
    reply.send({ok:true});
  });

  app.get("/v1/tenants/:tenantId/agents/:agentId/training-examples", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const scopedAgent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, scopedAgent.business_id);
    const result = await query("SELECT * FROM training_examples WHERE tenant_id=$1 AND agent_profile_id=$2 ORDER BY created_at DESC", [params.tenantId, params.agentId]);
    reply.send({ examples: result.rows });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/training-examples", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ inputText: z.string().max(10000).optional(), idealResponse: z.string().min(1).max(20000), labels: z.array(z.string().max(80)).max(30).default([]), input: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    const result = await query(`
      INSERT INTO training_examples(tenant_id,agent_profile_id,source,input_text,ideal_response,input_json,labels,approval_status,created_by)
      VALUES ($1,$2,'panel_simulator',$3,$4,$5::jsonb,$6,'approved',$7) RETURNING *
    `, [params.tenantId, params.agentId, input.inputText ?? null, input.idealResponse, JSON.stringify(input.input), input.labels, principal.userId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "TRAINING_EXAMPLE_CREATED", resourceType: "training_example", resourceId: result.rows[0].id, safeDiff: { labels: input.labels }, request });
    reply.code(201).send({ example: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/agents/:agentId/training-examples/:exampleId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),agentId:z.string().uuid(),exampleId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const agent=await loadAgent(params.tenantId,params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id, ["OWNER", "ADMIN", "STAFF"]);
    const input=z.object({approvalStatus:z.enum(["pending","approved","rejected"])}).parse(request.body);
    const result=await query<any>("UPDATE training_examples SET approval_status=$4 WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3 RETURNING *",[params.exampleId,params.tenantId,params.agentId,input.approvalStatus]);
    if(!result.rows[0]) throw new ApiError(404,"TRAINING_EXAMPLE_NOT_FOUND","Training example not found.");
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,action:"TRAINING_EXAMPLE_REVIEWED",resourceType:"training_example",resourceId:params.exampleId,safeDiff:input,request});
    reply.send({example:result.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/prompts/:promptId/discard", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),agentId:z.string().uuid(),promptId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const agent=await loadAgent(params.tenantId,params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id, ["OWNER", "ADMIN", "STAFF"]);
    const result=await query<any>("UPDATE prompt_versions SET status='rejected' WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3 AND status IN ('candidate','draft') RETURNING id,version,status",[params.promptId,params.tenantId,params.agentId]);
    if(!result.rows[0]) throw new ApiError(409,"PROMPT_NOT_DISCARDABLE","Prompt version cannot be discarded.");
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,action:"PROMPT_DISCARDED",resourceType:"prompt_version",resourceId:params.promptId,request});
    reply.send({prompt:result.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/training-jobs", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ modelConfigId: z.string().uuid().optional(), exampleIds: z.array(z.string().uuid()).min(1).max(200).optional() }).parse(request.body ?? {});
    const requestedExamples = input.exampleIds ? [...new Set(input.exampleIds)] : null;
    const examples = requestedExamples
      ? (await query<{ id: string }>(
        "SELECT id FROM training_examples WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND agent_profile_id=$3 AND approval_status='approved'",
        [requestedExamples, params.tenantId, params.agentId],
      )).rows.map((row) => row.id)
      : (await query<{ id: string }>("SELECT id FROM training_examples WHERE tenant_id=$1 AND agent_profile_id=$2 AND approval_status='approved' ORDER BY created_at", [params.tenantId, params.agentId])).rows.map((row) => row.id);
    if (requestedExamples && examples.length !== requestedExamples.length) {
      throw new ApiError(400, "TRAINING_EXAMPLES_INVALID", "Every selected training example must belong to this agent and be approved.");
    }
    if (!examples.length) throw new ApiError(400, "TRAINING_EXAMPLES_REQUIRED", "At least one approved training example is required.");
    if (input.modelConfigId) {
      const modelConfig = await query<{
        business_id: string | null;
        agent_profile_id: string | null;
        channel_business_id: string | null;
        provider_business_id: string | null;
        task_key: string;
      }>(`
        SELECT m.business_id,m.agent_profile_id,m.task_key,
          c.business_id AS channel_business_id,
          p.business_id AS provider_business_id
        FROM ai_model_configs m JOIN ai_provider_connections p ON p.id=m.provider_connection_id
        LEFT JOIN channel_accounts c ON c.id=m.channel_account_id AND c.tenant_id=m.tenant_id
        WHERE m.id=$1 AND m.tenant_id=$2 AND m.active=true
      `, [input.modelConfigId, params.tenantId]);
      const config = modelConfig.rows[0];
      if (!config || config.task_key !== "PROMPT_SYNTHESIS"
        || (config.business_id && config.business_id !== agent.business_id)
        || (config.agent_profile_id && config.agent_profile_id !== params.agentId)
        || (config.channel_business_id && config.channel_business_id !== agent.business_id)
        || (config.provider_business_id && config.provider_business_id !== agent.business_id)) {
        throw new ApiError(400, "MODEL_CONFIG_SCOPE_INVALID", "The selected training model is not valid for this agent.");
      }
    }
    const collectionVersions=await query<{id:string;schema_version:number;updated_at:Date}>(`
      SELECT c.id,c.schema_version,c.updated_at
      FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id
      WHERE acl.tenant_id=$1 AND c.tenant_id=$1 AND c.business_id=$2
        AND acl.agent_profile_id=$3 AND c.status='active'
      ORDER BY c.id
    `,[params.tenantId, agent.business_id, params.agentId]);
    const snapshot={
      exampleIds:examples,
      basePromptVersionId:agent.active_prompt_version_id ?? null,
      collectionVersions:collectionVersions.rows.map((row)=>({id:row.id,schemaVersion:Number(row.schema_version),updatedAt:row.updated_at})),
      capabilities:agent.capabilities ?? [],
      behaviorSettings:agent.behavior_settings ?? {},
      capturedAt:new Date().toISOString(),
    };
    const created = await query(`
      INSERT INTO training_jobs(tenant_id,agent_profile_id,base_prompt_version_id,model_config_id,input_snapshot)
      VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *
    `, [params.tenantId, params.agentId, agent.active_prompt_version_id ?? null, input.modelConfigId ?? null, JSON.stringify(snapshot)]);
    const jobId = created.rows[0].id as string;
    await enqueue(QUEUES.training, {
      jobId,
      jobType: "PROMPT_SYNTHESIS",
      tenantId: params.tenantId,
      businessId: agent.business_id,
      correlationId: requestId(request),
      idempotencyKey: `training:${jobId}`,
      createdAt: new Date().toISOString(),
      payload: { trainingJobId: jobId, agentProfileId: params.agentId },
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "TRAINING_JOB_STARTED", resourceType: "training_job", resourceId: jobId, safeDiff: { exampleCount: examples.length }, request });
    reply.code(202).send({ trainingJob: created.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/agents/:agentId/training-jobs", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const scopedAgent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, scopedAgent.business_id);
    const result = await query("SELECT * FROM training_jobs WHERE tenant_id=$1 AND agent_profile_id=$2 ORDER BY created_at DESC LIMIT 100", [params.tenantId, params.agentId]);
    reply.send({ jobs: result.rows });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/test", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    const principal = await requireAuth(request);
    requireCsrf(request);
    const agent = await loadAgent(params.tenantId, params.agentId);
    await requireBusinessAccess(request, params.tenantId, agent.business_id);
    const input = z.object({ message: z.string().min(1).max(20000), promptVersionId: z.string().uuid().optional() }).parse(request.body);
    const promptId = input.promptVersionId ?? agent.active_prompt_version_id;
    if (!promptId) throw new ApiError(400, "PROMPT_REQUIRED", "Agent does not have an active prompt.");
    const prompt = await query<{ assembled_prompt: string | null }>("SELECT assembled_prompt FROM prompt_versions WHERE id=$1 AND agent_profile_id=$2", [promptId, params.agentId]);
    if (!prompt.rows[0]) throw new ApiError(404, "PROMPT_NOT_FOUND", "Prompt not found.");
    const config = await query<any>(`
      SELECT m.model,m.parameters,p.provider,p.encrypted_api_key,p.base_url
      FROM ai_model_configs m JOIN ai_provider_connections p ON p.id=m.provider_connection_id
      WHERE m.tenant_id=$1 AND m.active=true AND p.status='active'
        AND (m.agent_profile_id=$2 OR m.agent_profile_id IS NULL)
        AND (m.business_id=$3 OR m.business_id IS NULL)
        AND (p.business_id=$3 OR p.business_id IS NULL)
        AND m.task_key='DEFAULT_CHAT'
      ORDER BY (m.agent_profile_id IS NOT NULL) DESC,(m.business_id IS NOT NULL) DESC,m.created_at DESC LIMIT 1
    `, [params.tenantId, params.agentId, agent.business_id]);
    if (!config.rows[0]) throw new ApiError(400, "AI_MODEL_MISSING", "No active DEFAULT_CHAT model configuration is available.");
    const result = await chat(config.rows[0], { model: config.rows[0].model, parameters: config.rows[0].parameters ?? {} }, { system: prompt.rows[0].assembled_prompt ?? "", messages: [{ role: "user", content: input.message }] });
    await query(`INSERT INTO usage_events(tenant_id,business_id,event_type,quantity,unit,provider,model,task_key,correlation_id,metadata)
      VALUES ($1,$2,'ai_call',1,'call',$3,$4,'DEFAULT_CHAT',$5,$6::jsonb)`, [params.tenantId, agent.business_id, config.rows[0].provider, config.rows[0].model, requestId(request), JSON.stringify(result.usage)]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: agent.business_id, action: "AGENT_TESTED", resourceType: "agent_profile", resourceId: params.agentId, safeDiff: { promptVersionId: promptId }, request });
    reply.send({ response: result.text, usage: result.usage, promptVersionId: promptId });
  });
}
