import { query } from "@n8n-automation/core";
import type { AiConnection } from "./ai-provider.js";
import { ApiError } from "./lib.js";

export type PlatformAiModel = AiConnection & {
  id: string;
  provider_connection_id: string;
  model: string;
  parameters: Record<string, unknown>;
  input_credits_per_1k_tokens: number | string;
  output_credits_per_1k_tokens: number | string;
  request_credits: number | string;
  priority: number;
  ownership_mode: "PLATFORM";
};

export type AiAllowance = {
  plan: { id: string | null; key: string | null; name: string | null };
  periodStart: string;
  tokenLimit: number | null;
  creditLimit: number | null;
  tokensUsed: number;
  creditsUsed: number;
  tokensRemaining: number | null;
  creditsRemaining: number | null;
};

export async function resolvePlatformModels(taskKey: string, limit = 5): Promise<PlatformAiModel[]> {
  const result = await query<any>(`
    SELECT r.id,r.model,r.parameters,r.priority,
      r.input_credits_per_1k_tokens,r.output_credits_per_1k_tokens,r.request_credits,
      p.id AS provider_connection_id,p.provider,p.encrypted_api_key,p.base_url,
      'PLATFORM'::text AS ownership_mode
    FROM platform_ai_model_routes r
    JOIN platform_ai_provider_connections p ON p.id=r.provider_connection_id
    WHERE r.task_key=$1 AND r.active=true AND p.status='active'
    ORDER BY r.priority ASC,r.created_at DESC
    LIMIT $2
  `,[taskKey,limit]);
  return result.rows as PlatformAiModel[];
}

export async function resolvePlatformModel(taskKey: string): Promise<PlatformAiModel | null> {
  return (await resolvePlatformModels(taskKey,1))[0] ?? null;
}

export async function monthlyAiAllowance(tenantId: string): Promise<AiAllowance> {
  const tenant = await query<any>(`
    SELECT t.plan_id,p.key AS plan_key,p.name AS plan_name,p.limits,
      (SELECT value FROM tenant_limit_overrides o WHERE o.tenant_id=t.id AND o.key='monthlyAiTokens' AND (o.expires_at IS NULL OR o.expires_at>now()) LIMIT 1) AS token_override,
      (SELECT value FROM tenant_limit_overrides o WHERE o.tenant_id=t.id AND o.key='monthlyAiCredits' AND (o.expires_at IS NULL OR o.expires_at>now()) LIMIT 1) AS credit_override
    FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
    WHERE t.id=$1
  `,[tenantId]);
  const row=tenant.rows[0];
  if(!row) throw new ApiError(404,"TENANT_NOT_FOUND","Tenant not found.");

  const usage=await query<any>(`
    SELECT COALESCE(SUM(total_tokens),0)::bigint AS tokens,
           COALESCE(SUM(credits),0)::numeric AS credits
    FROM usage_events
    WHERE tenant_id=$1 AND occurred_at>=date_trunc('month',now())
  `,[tenantId]);

  const rawTokenLimit=row.token_override ?? row.limits?.monthlyAiTokens ?? null;
  const rawCreditLimit=row.credit_override ?? row.limits?.monthlyAiCredits ?? null;
  const tokenLimit=rawTokenLimit===null||rawTokenLimit===undefined?null:Number(rawTokenLimit);
  const creditLimit=rawCreditLimit===null||rawCreditLimit===undefined?null:Number(rawCreditLimit);
  const tokensUsed=Number(usage.rows[0]?.tokens ?? 0);
  const creditsUsed=Number(usage.rows[0]?.credits ?? 0);
  return {
    plan:{id:row.plan_id??null,key:row.plan_key??null,name:row.plan_name??null},
    periodStart:new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString(),
    tokenLimit:Number.isFinite(tokenLimit as number)?tokenLimit:null,
    creditLimit:Number.isFinite(creditLimit as number)?creditLimit:null,
    tokensUsed,creditsUsed,
    tokensRemaining:tokenLimit===null?null:Math.max(0,tokenLimit-tokensUsed),
    creditsRemaining:creditLimit===null?null:Math.max(0,creditLimit-creditsUsed),
  };
}

export async function assertMonthlyAiAllowance(tenantId: string): Promise<AiAllowance> {
  const allowance=await monthlyAiAllowance(tenantId);
  if(allowance.tokenLimit!==null && allowance.tokensUsed>=allowance.tokenLimit){
    throw new ApiError(402,"AI_TOKEN_LIMIT_REACHED","The monthly AI token allowance has been reached.",{...allowance});
  }
  if(allowance.creditLimit!==null && allowance.creditsUsed>=allowance.creditLimit){
    throw new ApiError(402,"AI_CREDIT_LIMIT_REACHED","The monthly AI credit allowance has been reached.",{...allowance});
  }
  return allowance;
}

export function normalizeAiUsage(usage: any): {inputTokens:number;outputTokens:number;totalTokens:number} {
  const inputTokens=Math.max(0,Number(usage?.inputTokens ?? usage?.prompt_tokens ?? usage?.promptTokenCount ?? usage?.input_tokens ?? 0)||0);
  const outputTokens=Math.max(0,Number(usage?.outputTokens ?? usage?.completion_tokens ?? usage?.candidatesTokenCount ?? usage?.output_tokens ?? 0)||0);
  const reportedTotal=Math.max(0,Number(usage?.totalTokens ?? usage?.total_tokens ?? usage?.totalTokenCount ?? 0)||0);
  return {inputTokens,outputTokens,totalTokens:reportedTotal || inputTokens+outputTokens};
}

export function creditsForUsage(model: PlatformAiModel, usage: any): number {
  const normalized=normalizeAiUsage(usage);
  const inputRate=Number(model.input_credits_per_1k_tokens ?? 1);
  const outputRate=Number(model.output_credits_per_1k_tokens ?? 1);
  const requestRate=Number(model.request_credits ?? 0);
  const credits=requestRate+(normalized.inputTokens/1000)*inputRate+(normalized.outputTokens/1000)*outputRate;
  return Number.isFinite(credits)?Math.max(0,credits):0;
}

export async function recordPlatformAiUsage(input:{
  tenantId:string;
  businessId?:string|null;
  channelAccountId?:string|null;
  conversationId?:string|null;
  eventType?:string;
  quantity?:number;
  unit?:string;
  taskKey:string;
  model:PlatformAiModel;
  usage:any;
  correlationId?:string|null;
  idempotencyKey:string;
  metadata?:Record<string,unknown>;
}):Promise<void>{
  const normalized=normalizeAiUsage(input.usage);
  const credits=creditsForUsage(input.model,input.usage);
  await query(`
    INSERT INTO usage_events(
      tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,
      provider,model,task_key,input_tokens,output_tokens,total_tokens,credits,
      correlation_id,idempotency_key,metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
    ON CONFLICT DO NOTHING
  `,[
    input.tenantId,input.businessId??null,input.channelAccountId??null,input.conversationId??null,
    input.eventType??"ai_call",input.quantity??1,input.unit??"call",
    input.model.provider,input.model.model,input.taskKey,normalized.inputTokens,normalized.outputTokens,normalized.totalTokens,credits,
    input.correlationId??null,input.idempotencyKey,JSON.stringify({...input.usage,...(input.metadata??{}),platformModelRouteId:input.model.id})
  ]);
}
