import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "@n8n-automation/core";
import { chat } from "../ai-provider.js";
import { ApiError, audit, requireAuth, requireCsrf, requireTenant, requestId } from "../lib.js";
import { assertMonthlyAiAllowance, recordPlatformAiUsage, resolvePlatformModel } from "../platform-ai.js";

const customerProviderModelPattern=/^\/v1\/tenants\/([0-9a-f-]+)\/ai\/(?:providers|models)(?:\/|$)/i;
const agentTestPattern=/^\/v1\/tenants\/([0-9a-f-]+)\/agents\/([0-9a-f-]+)\/test(?:\?|$)/i;

export async function platformAiCustomerGuard(app:FastifyInstance){
  app.addHook("preHandler",async(request,reply)=>{
    const path=request.url.split("?")[0];
    const managed=path.match(customerProviderModelPattern);
    if(managed){
      await requireTenant(request,managed[1],["OWNER","ADMIN","STAFF"]);
      throw new ApiError(403,"PLATFORM_AI_MANAGED","AI providers and model routes are managed by the platform administrator. Your workspace uses the models included with its plan.");
    }

    if(request.method!=="POST") return;
    const match=path.match(agentTestPattern);
    if(!match) return;
    const tenantId=match[1];
    const agentId=match[2];
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input=z.object({message:z.string().min(1).max(10000)}).parse(request.body);
    await assertMonthlyAiAllowance(tenantId);
    const agent=await query<any>(`
      SELECT a.id,a.business_id,a.active_prompt_version_id,pv.assembled_prompt
      FROM agent_profiles a
      LEFT JOIN prompt_versions pv ON pv.id=a.active_prompt_version_id
      WHERE a.id=$1 AND a.tenant_id=$2 AND a.status='active'
    `,[agentId,tenantId]);
    const row=agent.rows[0];
    if(!row) throw new ApiError(404,"AGENT_NOT_FOUND","AI agent not found.");
    if(!row.active_prompt_version_id||!row.assembled_prompt) throw new ApiError(409,"AGENT_NOT_CONFIGURED","Agent has no active prompt.");
    const model=await resolvePlatformModel("DEFAULT_CHAT");
    if(!model) throw new ApiError(409,"AI_MODEL_MISSING","No platform DEFAULT_CHAT model is configured.");
    const result=await chat(model,{model:model.model,parameters:model.parameters??{}},{system:row.assembled_prompt,messages:[{role:"user",content:input.message}]});
    await recordPlatformAiUsage({
      tenantId,businessId:row.business_id,eventType:"ai_call",unit:"call",taskKey:"DEFAULT_CHAT",model,usage:result.usage,
      correlationId:requestId(request),idempotencyKey:`agent-test:${agentId}:${requestId(request)}`,metadata:{operation:"agent_test"}
    });
    await audit({actorUserId:principal.userId,tenantId,businessId:row.business_id,action:"AGENT_TESTED",resourceType:"agent_profile",resourceId:agentId,safeDiff:{promptVersionId:row.active_prompt_version_id,platformManagedAi:true},request});
    return reply.send({response:result.text,usage:result.usage,promptVersionId:row.active_prompt_version_id,platformManagedAi:true});
  });
}
