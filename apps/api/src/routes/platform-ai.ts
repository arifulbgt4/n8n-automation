import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decryptSecret, encryptSecret, maskSecret, query } from "@n8n-automation/core";
import { assertSafeAiBaseUrl, testConnection } from "../ai-provider.js";
import { ApiError, audit, requireCsrf, requirePlatformAdmin, requireRecentPlatformAdmin, requireTenant } from "../lib.js";
import { monthlyAiAllowance, resolvePlatformModel } from "../platform-ai.js";

const providerSchema=z.enum(["openai","anthropic","gemini","openai_compatible"]);
const taskSchema=z.enum(["DEFAULT_CHAT","INTENT_CLASSIFICATION","IMAGE_ANALYSIS","AUDIO_TRANSCRIPTION","STRUCTURED_EXTRACTION","PROMPT_SYNTHESIS","EMBEDDINGS"]);

async function providerById(id:string){
  const result=await query<any>("SELECT * FROM platform_ai_provider_connections WHERE id=$1",[id]);
  if(!result.rows[0]) throw new ApiError(404,"PLATFORM_AI_PROVIDER_NOT_FOUND","Platform AI provider not found.");
  return result.rows[0];
}

async function discoverModels(provider:any){
  const key=decryptSecret(provider.encrypted_api_key);
  let url="";let headers:Record<string,string>={};
  if(provider.provider==="openai"||provider.provider==="openai_compatible"){
    const base=provider.base_url?assertSafeAiBaseUrl(provider.base_url):"https://api.openai.com/v1";
    url=`${base}/models`;headers={authorization:`Bearer ${key}`};
  }else if(provider.provider==="anthropic"){
    url="https://api.anthropic.com/v1/models?limit=100";headers={"x-api-key":key,"anthropic-version":"2023-06-01"};
  }else{
    url=`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`;
  }
  const response=await fetch(url,{headers});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new ApiError(502,"PLATFORM_AI_CATALOG_FAILED",body?.error?.message||body?.message||`Provider returned ${response.status}`);
  if(provider.provider==="openai"||provider.provider==="openai_compatible") return (body.data??[]).map((x:any)=>({id:String(x.id),label:String(x.id)})).filter((x:any)=>x.id).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  if(provider.provider==="anthropic") return (body.data??[]).map((x:any)=>({id:String(x.id),label:String(x.display_name||x.id)})).filter((x:any)=>x.id).sort((a:any,b:any)=>a.id.localeCompare(b.id));
  return (body.models??[]).map((x:any)=>({id:String(x.name||"").replace(/^models\//,""),label:String(x.displayName||x.name||"")})).filter((x:any)=>x.id).sort((a:any,b:any)=>a.id.localeCompare(b.id));
}

export async function platformAiRoutes(app:FastifyInstance){
  app.get("/v1/tenants/:tenantId/ai/allowance",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId);
    reply.send(await monthlyAiAllowance(tenantId));
  });

  app.get("/v1/admin/platform-ai/providers",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const rows=await query(`SELECT id,name,provider,key_hint,base_url,status,metadata,last_tested_at,created_at,updated_at FROM platform_ai_provider_connections ORDER BY created_at DESC`);
    reply.send({providers:rows.rows});
  });

  app.post("/v1/admin/platform-ai/providers",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request);requireCsrf(request);
    const input=z.object({name:z.string().trim().min(1).max(120),provider:providerSchema,apiKey:z.string().min(6),baseUrl:z.string().url().nullable().optional()}).parse(request.body);
    if(input.provider==="openai_compatible"&&!input.baseUrl) throw new ApiError(400,"BASE_URL_REQUIRED","Base URL is required for OpenAI-compatible providers.");
    const baseUrl=input.baseUrl?assertSafeAiBaseUrl(input.baseUrl):null;
    const result=await query<any>(`INSERT INTO platform_ai_provider_connections(name,provider,encrypted_api_key,key_hint,base_url) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,provider,key_hint,base_url,status,created_at`,[input.name,input.provider,encryptSecret(input.apiKey),maskSecret(input.apiKey),baseUrl]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLATFORM_AI_PROVIDER_CREATED",resourceType:"platform_ai_provider",resourceId:result.rows[0].id,safeDiff:{name:input.name,provider:input.provider,baseUrl},request});
    reply.code(201).send({provider:result.rows[0]});
  });

  app.patch("/v1/admin/platform-ai/providers/:providerId",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request);requireCsrf(request);
    const {providerId}=z.object({providerId:z.string().uuid()}).parse(request.params);
    const input=z.object({name:z.string().trim().min(1).max(120).optional(),apiKey:z.string().min(6).optional(),baseUrl:z.string().url().nullable().optional(),status:z.enum(["active","invalid","disabled"]).optional()}).parse(request.body);
    await providerById(providerId);
    const hasBase=Object.prototype.hasOwnProperty.call(input,"baseUrl");
    const baseUrl=input.baseUrl?assertSafeAiBaseUrl(input.baseUrl):null;
    const result=await query<any>(`UPDATE platform_ai_provider_connections SET name=COALESCE($2,name),encrypted_api_key=CASE WHEN $3::boolean THEN $4 ELSE encrypted_api_key END,key_hint=CASE WHEN $3::boolean THEN $5 ELSE key_hint END,base_url=CASE WHEN $6::boolean THEN $7 ELSE base_url END,status=COALESCE($8,status),updated_at=now() WHERE id=$1 RETURNING id,name,provider,key_hint,base_url,status,updated_at`,[providerId,input.name??null,Boolean(input.apiKey),input.apiKey?encryptSecret(input.apiKey):null,input.apiKey?maskSecret(input.apiKey):null,hasBase,baseUrl,input.status??null]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLATFORM_AI_PROVIDER_UPDATED",resourceType:"platform_ai_provider",resourceId:providerId,safeDiff:{name:input.name,keyReplaced:Boolean(input.apiKey),baseUrl:hasBase?baseUrl:undefined,status:input.status},request});
    reply.send({provider:result.rows[0]});
  });

  app.post("/v1/admin/platform-ai/providers/:providerId/test",async(request,reply)=>{
    const principal=await requirePlatformAdmin(request);requireCsrf(request);
    const {providerId}=z.object({providerId:z.string().uuid()}).parse(request.params);
    const input=z.object({model:z.string().trim().min(1).optional()}).parse(request.body??{});
    const provider=await providerById(providerId);
    const test=await testConnection(provider,input.model?{model:input.model,parameters:{}}:undefined);
    await query("UPDATE platform_ai_provider_connections SET status=$2,last_tested_at=now(),updated_at=now() WHERE id=$1",[providerId,test.ok?"active":"invalid"]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLATFORM_AI_PROVIDER_TESTED",resourceType:"platform_ai_provider",resourceId:providerId,safeDiff:{ok:test.ok,model:input.model},request});
    reply.send(test);
  });

  app.get("/v1/admin/platform-ai/providers/:providerId/catalog",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const {providerId}=z.object({providerId:z.string().uuid()}).parse(request.params);
    const provider=await providerById(providerId);
    reply.send({providerId,provider:provider.provider,models:await discoverModels(provider)});
  });

  app.get("/v1/admin/platform-ai/models",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const rows=await query(`SELECT r.*,p.name AS provider_name,p.provider,p.status AS provider_status FROM platform_ai_model_routes r JOIN platform_ai_provider_connections p ON p.id=r.provider_connection_id ORDER BY r.task_key,r.priority,r.created_at DESC`);
    reply.send({models:rows.rows});
  });

  app.post("/v1/admin/platform-ai/models",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request);requireCsrf(request);
    const input=z.object({providerConnectionId:z.string().uuid(),taskKey:taskSchema,model:z.string().trim().min(1).max(160),priority:z.number().int().min(0).max(10000).default(100),parameters:z.record(z.string(),z.unknown()).default({}),inputCreditsPer1kTokens:z.number().nonnegative().default(1),outputCreditsPer1kTokens:z.number().nonnegative().default(1),requestCredits:z.number().nonnegative().default(0),active:z.boolean().default(true)}).parse(request.body);
    const provider=await providerById(input.providerConnectionId);
    const test=await testConnection(provider,{model:input.model,parameters:input.parameters});
    if(!test.ok&&input.taskKey==="DEFAULT_CHAT") throw new ApiError(400,"PLATFORM_AI_MODEL_TEST_FAILED",test.detail);
    const result=await query<any>(`INSERT INTO platform_ai_model_routes(provider_connection_id,task_key,model,parameters,priority,active,input_credits_per_1k_tokens,output_credits_per_1k_tokens,request_credits) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *`,[input.providerConnectionId,input.taskKey,input.model,JSON.stringify(input.parameters),input.priority,input.active,input.inputCreditsPer1kTokens,input.outputCreditsPer1kTokens,input.requestCredits]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLATFORM_AI_MODEL_CREATED",resourceType:"platform_ai_model_route",resourceId:result.rows[0].id,safeDiff:{taskKey:input.taskKey,model:input.model,priority:input.priority},request});
    reply.code(201).send({model:result.rows[0]});
  });

  app.patch("/v1/admin/platform-ai/models/:modelId",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request);requireCsrf(request);
    const {modelId}=z.object({modelId:z.string().uuid()}).parse(request.params);
    const input=z.object({priority:z.number().int().min(0).max(10000).optional(),active:z.boolean().optional(),parameters:z.record(z.string(),z.unknown()).optional(),inputCreditsPer1kTokens:z.number().nonnegative().optional(),outputCreditsPer1kTokens:z.number().nonnegative().optional(),requestCredits:z.number().nonnegative().optional()}).parse(request.body);
    const result=await query<any>(`UPDATE platform_ai_model_routes SET priority=COALESCE($2,priority),active=COALESCE($3,active),parameters=CASE WHEN $4::jsonb IS NULL THEN parameters ELSE $4::jsonb END,input_credits_per_1k_tokens=COALESCE($5,input_credits_per_1k_tokens),output_credits_per_1k_tokens=COALESCE($6,output_credits_per_1k_tokens),request_credits=COALESCE($7,request_credits),updated_at=now() WHERE id=$1 RETURNING *`,[modelId,input.priority??null,input.active??null,input.parameters?JSON.stringify(input.parameters):null,input.inputCreditsPer1kTokens??null,input.outputCreditsPer1kTokens??null,input.requestCredits??null]);
    if(!result.rows[0]) throw new ApiError(404,"PLATFORM_AI_MODEL_NOT_FOUND","Platform AI model route not found.");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLATFORM_AI_MODEL_UPDATED",resourceType:"platform_ai_model_route",resourceId:modelId,safeDiff:input,request});
    reply.send({model:result.rows[0]});
  });

  app.get("/v1/admin/platform-ai/defaults",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const tasks=taskSchema.options;
    const defaults=await Promise.all(tasks.map(async(task)=>({task,model:await resolvePlatformModel(task)})));
    reply.send({defaults:defaults.map(({task,model})=>({task,model:model?{id:model.id,provider:model.provider,model:model.model,priority:model.priority}:null}))});
  });
}
