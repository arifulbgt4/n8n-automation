import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "@n8n-automation/core";
import { chat } from "../ai-provider.js";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, requestId } from "../lib.js";
import { assertDailyAiAllowance, recordPlatformAiUsage, resolvePlatformModel } from "../platform-ai.js";

const customerProviderModelPattern=/^\/v1\/tenants\/:tenantId\/ai\/(providers|models)(?:\/|$)/;
const agentTestRoute="/v1/tenants/:tenantId/agents/:agentId/test";

export async function platformAiCustomerGuard(app:FastifyInstance){
  app.addHook("preHandler",async(request,reply)=>{
    // Match Fastify's canonical route and validated decoded parameters. A raw
    // URL check can miss percent-encoded UUIDs that the router still accepts.
    const route=request.routeOptions.url;
    if(!route) return;
    const managed=route.match(customerProviderModelPattern);
    if(managed){
      const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
      await requireTenant(request,tenantId,["OWNER","ADMIN","STAFF"]);
      // Transitional compatibility for the existing Customer AI Agents screen: it may still
      // read these collections while the provider/model controls are being removed from the UI.
      // Never expose platform credentials or routes through tenant APIs.
      if(request.method==="GET" && route===`/v1/tenants/:tenantId/ai/${managed[1]}`){
        return reply.send(managed[1]==="providers"?{providers:[]}:{models:[]});
      }
      throw new ApiError(403,"PLATFORM_AI_MANAGED","AI providers and model routes are managed by the platform administrator. Your workspace uses the models included with its plan.");
    }

    if(request.method!=="POST" || route!==agentTestRoute) return;
    const {tenantId,agentId}=z.object({tenantId:z.string().uuid(),agentId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input=z.object({message:z.string().min(1).max(10000),promptVersionId:z.string().uuid().optional()}).parse(request.body);
    await assertDailyAiAllowance(tenantId);
    const agent=await query<any>(`
      SELECT a.id,a.business_id,a.active_prompt_version_id
      FROM agent_profiles a
      WHERE a.id=$1 AND a.tenant_id=$2 AND a.status='active'
    `,[agentId,tenantId]);
    const row=agent.rows[0];
    if(!row) throw new ApiError(404,"AGENT_NOT_FOUND","AI agent not found.");
    await requireBusinessAccess(request, tenantId, row.business_id, ["OWNER", "ADMIN", "STAFF"]);
    const promptId=input.promptVersionId??row.active_prompt_version_id;
    if(!promptId) throw new ApiError(409,"AGENT_NOT_CONFIGURED","Agent has no active prompt.");
    const prompt=await query<any>("SELECT id,assembled_prompt,status FROM prompt_versions WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3",[promptId,tenantId,agentId]);
    if(!prompt.rows[0]?.assembled_prompt) throw new ApiError(404,"PROMPT_NOT_FOUND","Prompt version not found.");
    const model=await resolvePlatformModel("DEFAULT_CHAT");
    if(!model) throw new ApiError(409,"AI_MODEL_MISSING","No platform DEFAULT_CHAT model is configured.");
    const result=await chat(model,{model:model.model,parameters:model.parameters??{}},{system:prompt.rows[0].assembled_prompt,messages:[{role:"user",content:input.message}]});
    await recordPlatformAiUsage({
      tenantId,businessId:row.business_id,eventType:"ai_call",unit:"call",taskKey:"DEFAULT_CHAT",model,usage:result.usage,
      correlationId:requestId(request),idempotencyKey:`agent-test:${agentId}:${promptId}:${requestId(request)}`,metadata:{operation:"agent_test",promptVersionId:promptId}
    });
    await audit({actorUserId:principal.userId,tenantId,businessId:row.business_id,action:"AGENT_TESTED",resourceType:"agent_profile",resourceId:agentId,safeDiff:{promptVersionId:promptId,platformManagedAi:true},request});
    return reply.send({response:result.text,promptVersionId:promptId,platformManagedAi:true});
  });
}
