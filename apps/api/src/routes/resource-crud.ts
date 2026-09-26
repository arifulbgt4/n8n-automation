import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, transaction } from "@n8n-automation/core";
import {
  ApiError,
  audit,
  requireAuth,
  requireBusinessAccess,
  requireCsrf,
  requireRecentPlatformAdmin,
} from "../lib.js";

/**
 * Destructive/resource-lifecycle endpoints that complement the create/update
 * routes owned by the domain modules. Tenant-owned business/agent/channel deletion
 * is archival so dependent operational/audit records remain intact. Provider IDs
 * are released on channel deletion so the same external account can be connected
 * again later as a new channel.
 */
export async function resourceCrudRoutes(app: FastifyInstance) {
  app.delete("/v1/tenants/:tenantId/businesses/:businessId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), businessId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireBusinessAccess(request, params.tenantId, params.businessId, ["OWNER", "ADMIN"]);
    requireCsrf(request);

    const result = await transaction(async (client) => {
      const business = await client.query<{ id: string; name: string; status: string }>(
        "SELECT id,name,status FROM businesses WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [params.businessId, params.tenantId],
      );
      if (!business.rows[0] || business.rows[0].status === "archived") throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");

      const channels = await client.query<{ id: string }>(
        "SELECT id FROM channel_accounts WHERE business_id=$1 AND tenant_id=$2",
        [params.businessId, params.tenantId],
      );
      const channelIds = channels.rows.map((row) => row.id);

      await client.query("UPDATE businesses SET status='archived',updated_at=now() WHERE id=$1 AND tenant_id=$2", [params.businessId, params.tenantId]);
      await client.query(`
        UPDATE channel_accounts SET
          active=false,
          connection_status='disconnected',
          default_agent_profile_id=NULL,
          external_account_id='deleted:'||id::text||':'||external_account_id,
          settings_json=settings_json||jsonb_build_object('deletedAt',now(),'deletedWithBusinessId',$1::text),
          updated_at=now()
        WHERE business_id=$1 AND tenant_id=$2
          AND NOT (settings_json ? 'deletedAt')
      `, [params.businessId, params.tenantId]);
      if (channelIds.length) await client.query("DELETE FROM channel_credentials WHERE channel_account_id=ANY($1::uuid[])", [channelIds]);
      await client.query("UPDATE agent_profiles SET status='archived',updated_at=now() WHERE business_id=$1 AND tenant_id=$2", [params.businessId, params.tenantId]);
      await client.query("UPDATE collections SET status='archived',updated_at=now() WHERE business_id=$1 AND tenant_id=$2", [params.businessId, params.tenantId]);
      await client.query("UPDATE followup_policies SET active=false,updated_at=now() WHERE business_id=$1 AND tenant_id=$2", [params.businessId, params.tenantId]);
      await client.query("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE business_id=$1 AND tenant_id=$2 AND status IN ('scheduled','queued')", [params.businessId, params.tenantId]);
      await client.query("UPDATE conversations SET mode='PAUSED',state_version=state_version+1,updated_at=now() WHERE business_id=$1 AND tenant_id=$2 AND status='open'", [params.businessId, params.tenantId]);

      return { business: business.rows[0], channelCount: channelIds.length };
    });

    await audit({actorUserId: principal.userId,tenantId: params.tenantId,businessId: params.businessId,action: "BUSINESS_DELETED",resourceType: "business",resourceId: params.businessId,safeDiff: { mode: "archive", channelCount: result.channelCount },request});
    reply.send({ ok: true, deleted: true, mode: "archive" });
  });

  app.delete("/v1/tenants/:tenantId/channels/:channelId/remove", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const channel = await query<{ id:string; business_id:string; name:string; settings_json:Record<string,unknown> }>(
      "SELECT id,business_id,name,settings_json FROM channel_accounts WHERE id=$1 AND tenant_id=$2",
      [params.channelId, params.tenantId],
    );
    if (!channel.rows[0] || channel.rows[0].settings_json?.deletedAt) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await requireBusinessAccess(request, params.tenantId, channel.rows[0].business_id, ["OWNER", "ADMIN"]);
    requireCsrf(request);

    await transaction(async (client) => {
      await client.query("DELETE FROM channel_credentials WHERE channel_account_id=$1", [params.channelId]);
      await client.query("UPDATE followup_policies SET active=false,updated_at=now() WHERE tenant_id=$1 AND channel_account_id=$2", [params.tenantId, params.channelId]);
      await client.query("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND channel_account_id=$2 AND status IN ('scheduled','queued')", [params.tenantId, params.channelId]);
      await client.query("UPDATE conversations SET mode='PAUSED',state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND channel_account_id=$2 AND status='open'", [params.tenantId, params.channelId]);
      await client.query(`
        UPDATE channel_accounts SET
          active=false,
          connection_status='disconnected',
          default_agent_profile_id=NULL,
          external_account_id='deleted:'||id::text||':'||external_account_id,
          public_identifier=NULL,
          settings_json=settings_json||jsonb_build_object('deletedAt',now()),
          updated_at=now()
        WHERE id=$1 AND tenant_id=$2
      `, [params.channelId, params.tenantId]);
    });

    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:channel.rows[0].business_id,action:"CHANNEL_DELETED",resourceType:"channel_account",resourceId:params.channelId,safeDiff:{mode:"archive",credentialsRemoved:true},request});
    reply.send({ok:true,deleted:true,mode:"archive"});
  });

  app.delete("/v1/tenants/:tenantId/agents/:agentId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const agent = await query<{ id: string; business_id: string; status: string }>("SELECT id,business_id,status FROM agent_profiles WHERE id=$1 AND tenant_id=$2", [params.agentId, params.tenantId]);
    if (!agent.rows[0] || agent.rows[0].status === "archived") throw new ApiError(404, "AGENT_NOT_FOUND", "AI agent not found.");
    await requireBusinessAccess(request, params.tenantId, agent.rows[0].business_id, ["OWNER", "ADMIN"]);
    requireCsrf(request);

    await transaction(async (client) => {
      await client.query("UPDATE channel_accounts SET default_agent_profile_id=NULL,updated_at=now() WHERE tenant_id=$1 AND default_agent_profile_id=$2", [params.tenantId, params.agentId]);
      await client.query("UPDATE conversations SET agent_profile_id=NULL,mode='PAUSED',state_version=state_version+1,updated_at=now() WHERE tenant_id=$1 AND agent_profile_id=$2 AND status='open'", [params.tenantId, params.agentId]);
      await client.query("DELETE FROM agent_channel_links WHERE agent_profile_id=$1", [params.agentId]);
      await client.query("DELETE FROM agent_collection_links WHERE agent_profile_id=$1", [params.agentId]);
      await client.query("UPDATE agent_profiles SET status='archived',updated_at=now() WHERE id=$1 AND tenant_id=$2", [params.agentId, params.tenantId]);
      await client.query("UPDATE followup_policies SET active=false,updated_at=now() WHERE tenant_id=$1 AND agent_profile_id=$2", [params.tenantId, params.agentId]);
      await client.query("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE tenant_id=$1 AND agent_profile_id=$2 AND status IN ('scheduled','queued')", [params.tenantId, params.agentId]);
    });

    await audit({actorUserId: principal.userId,tenantId: params.tenantId,businessId: agent.rows[0].business_id,action: "AGENT_DELETED",resourceType: "agent_profile",resourceId: params.agentId,safeDiff: { mode: "archive" },request});
    reply.send({ ok: true, deleted: true, mode: "archive" });
  });

  app.delete("/v1/admin/platform-ai/providers/:providerId", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request);requireCsrf(request);
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    const provider = await query<{ id: string; name: string; provider: string }>("SELECT id,name,provider FROM platform_ai_provider_connections WHERE id=$1", [providerId]);
    if (!provider.rows[0]) throw new ApiError(404, "PLATFORM_AI_PROVIDER_NOT_FOUND", "Platform AI provider not found.");
    const routes = await query<{ count: string }>("SELECT count(*)::text AS count FROM platform_ai_model_routes WHERE provider_connection_id=$1", [providerId]);
    await query("DELETE FROM platform_ai_provider_connections WHERE id=$1", [providerId]);
    await audit({actorUserId: principal.userId,actorType: "platform_admin",action: "PLATFORM_AI_PROVIDER_DELETED",resourceType: "platform_ai_provider",resourceId: providerId,safeDiff: {name: provider.rows[0].name,provider: provider.rows[0].provider,deletedModelRoutes: Number(routes.rows[0]?.count ?? 0)},request});
    reply.send({ ok: true, deletedModelRoutes: Number(routes.rows[0]?.count ?? 0) });
  });

  app.delete("/v1/admin/platform-ai/models/:modelId", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request);requireCsrf(request);
    const { modelId } = z.object({ modelId: z.string().uuid() }).parse(request.params);
    const row = await query<{ id: string; task_key: string; model: string }>("DELETE FROM platform_ai_model_routes WHERE id=$1 RETURNING id,task_key,model", [modelId]);
    if (!row.rows[0]) throw new ApiError(404, "PLATFORM_AI_MODEL_NOT_FOUND", "Platform AI model route not found.");
    await audit({actorUserId: principal.userId,actorType: "platform_admin",action: "PLATFORM_AI_MODEL_DELETED",resourceType: "platform_ai_model_route",resourceId: modelId,safeDiff: { taskKey: row.rows[0].task_key, model: row.rows[0].model },request});
    reply.send({ ok: true });
  });

  app.delete("/v1/admin/ai-model-registry/:provider/:model", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request);requireCsrf(request);
    const params = z.object({ provider: z.string().min(1).max(80), model: z.string().min(1).max(200) }).parse(request.params);
    const row = await query<{ id: string }>("DELETE FROM ai_model_registry WHERE provider=$1 AND model=$2 RETURNING id", [params.provider, params.model]);
    if (!row.rows[0]) throw new ApiError(404, "AI_MODEL_REGISTRY_NOT_FOUND", "AI model registry entry not found.");
    await audit({actorUserId: principal.userId,actorType: "platform_admin",action: "AI_MODEL_REGISTRY_DELETED",resourceType: "ai_model_registry",resourceId: row.rows[0].id,safeDiff: params,request});
    reply.send({ ok: true });
  });

  app.delete("/v1/admin/prompt-templates/:templateId", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request);requireCsrf(request);
    const { templateId } = z.object({ templateId: z.string().uuid() }).parse(request.params);
    const row = await query<{ id: string; key: string; name: string }>("DELETE FROM prompt_templates WHERE id=$1 RETURNING id,key,name", [templateId]);
    if (!row.rows[0]) throw new ApiError(404, "PROMPT_TEMPLATE_NOT_FOUND", "Prompt template not found.");
    await audit({actorUserId: principal.userId,actorType: "platform_admin",action: "PROMPT_TEMPLATE_DELETED",resourceType: "prompt_template",resourceId: templateId,safeDiff: { key: row.rows[0].key, name: row.rows[0].name },request});
    reply.send({ ok: true });
  });

  app.delete("/v1/admin/feature-flags/:key", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request);requireCsrf(request);
    const { key } = z.object({ key: z.string().min(1).max(120) }).parse(request.params);
    const row = await query<{ key: string }>("DELETE FROM feature_flags WHERE key=$1 RETURNING key", [key]);
    if (!row.rows[0]) throw new ApiError(404, "FEATURE_FLAG_NOT_FOUND", "Feature flag not found.");
    await audit({actorUserId: principal.userId,actorType: "platform_admin",action: "FEATURE_FLAG_DELETED",resourceType: "feature_flag",resourceId: key,request});
    reply.send({ ok: true });
  });
}
