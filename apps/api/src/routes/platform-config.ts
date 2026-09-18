import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requirePlatformAdmin, requireTenant } from "../lib.js";

async function validatePolicyScope(tenantId:string,businessId:string,agentProfileId?:string|null,channelAccountId?:string|null){
  const business=await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2 AND status<>'archived'",[businessId,tenantId]);
  if(!business.rows[0]) throw new ApiError(404,"BUSINESS_NOT_FOUND","Business not found.");
  if(agentProfileId){
    const agent=await query("SELECT id FROM agent_profiles WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND status<>'archived'",[agentProfileId,tenantId,businessId]);
    if(!agent.rows[0]) throw new ApiError(400,"AGENT_SCOPE_INVALID","Agent does not belong to this business.");
  }
  if(channelAccountId){
    const channel=await query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3",[channelAccountId,tenantId,businessId]);
    if(!channel.rows[0]) throw new ApiError(400,"CHANNEL_SCOPE_INVALID","Channel does not belong to this business.");
  }
}

export async function platformConfigRoutes(app:FastifyInstance){
  app.get("/v1/tenants/:tenantId/billing",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId,["OWNER","ADMIN"]);
    const [tenant,subscription,prices,records,credits,invoices]=await Promise.all([
      query(`SELECT t.id,t.name,t.status,t.plan_id,p.key AS plan_key,p.name AS plan_name,p.features,p.limits
             FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`,[tenantId]),
      query("SELECT * FROM tenant_subscriptions WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1",[tenantId]),
      query(`SELECT pp.* FROM plan_prices pp JOIN tenants t ON t.plan_id=pp.plan_id WHERE t.id=$1 AND pp.active=true ORDER BY billing_interval,currency`,[tenantId]),
      query("SELECT * FROM usage_billing_records WHERE tenant_id=$1 ORDER BY period_start DESC LIMIT 24",[tenantId]),
      query("SELECT id,amount,currency,reason,expires_at,created_at FROM tenant_credits WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",[tenantId]),
      query("SELECT id,provider,external_invoice_id,status,currency,amount_due,amount_paid,hosted_url,issued_at,due_at,paid_at,created_at FROM invoice_records WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100",[tenantId])
    ]);
    reply.send({tenant:tenant.rows[0]??null,subscription:subscription.rows[0]??null,prices:prices.rows,usageBilling:records.rows,credits:credits.rows,invoices:invoices.rows});
  });

  app.get("/v1/tenants/:tenantId/retention",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId,["OWNER","ADMIN"]);
    const result=await query("SELECT * FROM retention_policies WHERE tenant_id=$1",[tenantId]);
    reply.send({policy:result.rows[0]??{tenant_id:tenantId,conversation_days:null,media_days:null,audit_days:null,training_days:null,hard_delete_after_days:null}});
  });

  app.put("/v1/tenants/:tenantId/retention",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER"]);
    requireCsrf(request);
    const input=z.object({
      conversationDays:z.number().int().min(1).max(3650).nullable().optional(),
      mediaDays:z.number().int().min(1).max(3650).nullable().optional(),
      auditDays:z.number().int().min(30).max(3650).nullable().optional(),
      trainingDays:z.number().int().min(1).max(3650).nullable().optional(),
      hardDeleteAfterDays:z.number().int().min(1).max(3650).nullable().optional(),
      metadata:z.record(z.string(),z.unknown()).default({})
    }).parse(request.body);
    const result=await query<any>(`
      INSERT INTO retention_policies(tenant_id,conversation_days,media_days,audit_days,training_days,hard_delete_after_days,metadata,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT(tenant_id) DO UPDATE SET
        conversation_days=EXCLUDED.conversation_days,media_days=EXCLUDED.media_days,audit_days=EXCLUDED.audit_days,
        training_days=EXCLUDED.training_days,hard_delete_after_days=EXCLUDED.hard_delete_after_days,
        metadata=EXCLUDED.metadata,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING *
    `,[tenantId,input.conversationDays??null,input.mediaDays??null,input.auditDays??null,input.trainingDays??null,input.hardDeleteAfterDays??null,JSON.stringify(input.metadata),principal.userId]);
    await audit({actorUserId:principal.userId,tenantId,action:"RETENTION_POLICY_UPDATED",resourceType:"retention_policy",resourceId:tenantId,safeDiff:input,request});
    reply.send({policy:result.rows[0]});
  });

  app.get("/v1/tenants/:tenantId/followup-policies",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const context=await requireTenant(request,tenantId);
    const scope=context.membershipRole==="OWNER"?null:context.businessScope??null;
    const q=z.object({businessId:z.string().uuid().optional()}).parse(request.query);
    const result=await query(`
      SELECT fp.*,a.name AS agent_name,c.name AS channel_name,c.platform
      FROM followup_policies fp
      LEFT JOIN agent_profiles a ON a.id=fp.agent_profile_id
      LEFT JOIN channel_accounts c ON c.id=fp.channel_account_id
      WHERE fp.tenant_id=$1 AND ($2::uuid IS NULL OR fp.business_id=$2)
        AND ($3::uuid[] IS NULL OR fp.business_id=ANY($3::uuid[]))
      ORDER BY fp.created_at DESC
    `,[tenantId,q.businessId??null,scope]);
    reply.send({policies:result.rows});
  });

  app.post("/v1/tenants/:tenantId/followup-policies",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input=z.object({
      businessId:z.string().uuid(),
      agentProfileId:z.string().uuid().nullable().optional(),
      channelAccountId:z.string().uuid().nullable().optional(),
      name:z.string().trim().min(1).max(160),
      active:z.boolean().default(true),
      delayMinutes:z.number().int().min(1).max(43200).default(60),
      maxWindowHours:z.number().min(1).max(72).default(23),
      messageTemplate:z.string().trim().min(1).max(5000),
      rules:z.record(z.string(),z.unknown()).default({})
    }).parse(request.body);
    await requireBusinessAccess(request,tenantId,input.businessId,["OWNER","ADMIN","STAFF"]);
    await validatePolicyScope(tenantId,input.businessId,input.agentProfileId,input.channelAccountId);
    const row=await query<any>(`
      INSERT INTO followup_policies(tenant_id,business_id,agent_profile_id,channel_account_id,name,active,delay_minutes,max_window_hours,message_template,rules_json,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *
    `,[tenantId,input.businessId,input.agentProfileId??null,input.channelAccountId??null,input.name,input.active,input.delayMinutes,input.maxWindowHours,input.messageTemplate,JSON.stringify(input.rules),principal.userId]);
    await audit({actorUserId:principal.userId,tenantId,businessId:input.businessId,action:"FOLLOWUP_POLICY_CREATED",resourceType:"followup_policy",resourceId:row.rows[0].id,safeDiff:{name:input.name,delayMinutes:input.delayMinutes},request});
    reply.code(201).send({policy:row.rows[0]});
  });

  app.patch("/v1/tenants/:tenantId/followup-policies/:policyId",async(request,reply)=>{
    const params=z.object({tenantId:z.string().uuid(),policyId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    const current=await query<any>("SELECT * FROM followup_policies WHERE id=$1 AND tenant_id=$2",[params.policyId,params.tenantId]);
    if(!current.rows[0]) throw new ApiError(404,"FOLLOWUP_POLICY_NOT_FOUND","Follow-up policy not found.");
    await requireBusinessAccess(request,params.tenantId,current.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input=z.object({
      name:z.string().trim().min(1).max(160).optional(),active:z.boolean().optional(),
      delayMinutes:z.number().int().min(1).max(43200).optional(),maxWindowHours:z.number().min(1).max(72).optional(),
      messageTemplate:z.string().trim().min(1).max(5000).optional(),rules:z.record(z.string(),z.unknown()).optional()
    }).parse(request.body);
    const row=await query<any>(`
      UPDATE followup_policies SET name=COALESCE($3,name),active=COALESCE($4,active),delay_minutes=COALESCE($5,delay_minutes),
        max_window_hours=COALESCE($6,max_window_hours),message_template=COALESCE($7,message_template),
        rules_json=CASE WHEN $8::jsonb IS NULL THEN rules_json ELSE rules_json||$8::jsonb END,updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *
    `,[params.policyId,params.tenantId,input.name??null,input.active??null,input.delayMinutes??null,input.maxWindowHours??null,input.messageTemplate??null,input.rules?JSON.stringify(input.rules):null]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:current.rows[0].business_id,action:"FOLLOWUP_POLICY_UPDATED",resourceType:"followup_policy",resourceId:params.policyId,safeDiff:input,request});
    reply.send({policy:row.rows[0]});
  });

  app.delete("/v1/tenants/:tenantId/followup-policies/:policyId",async(request,reply)=>{
    const params=z.object({tenantId:z.string().uuid(),policyId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    const current=await query<any>("SELECT business_id FROM followup_policies WHERE id=$1 AND tenant_id=$2",[params.policyId,params.tenantId]);
    if(!current.rows[0]) throw new ApiError(404,"FOLLOWUP_POLICY_NOT_FOUND","Follow-up policy not found.");
    await requireBusinessAccess(request,params.tenantId,current.rows[0].business_id,["OWNER","ADMIN"]);
    requireCsrf(request);
    await query("DELETE FROM followup_policies WHERE id=$1",[params.policyId]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:current.rows[0].business_id,action:"FOLLOWUP_POLICY_DELETED",resourceType:"followup_policy",resourceId:params.policyId,request});
    reply.send({ok:true});
  });

  app.get("/v1/tenants/:tenantId/quota-alerts",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId,["OWNER","ADMIN"]);
    const result=await query("SELECT * FROM quota_alerts WHERE tenant_id=$1 ORDER BY key,threshold_percent",[tenantId]);
    reply.send({alerts:result.rows});
  });

  app.post("/v1/tenants/:tenantId/quota-alerts",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER","ADMIN"]);
    requireCsrf(request);
    const input=z.object({key:z.string().min(1).max(120),thresholdPercent:z.number().min(1).max(100),channel:z.enum(["in_app","email"]).default("in_app"),recipients:z.array(z.string().email()).max(20).default([]),active:z.boolean().default(true)}).parse(request.body);
    const row=await query<any>(`
      INSERT INTO quota_alerts(tenant_id,key,threshold_percent,channel,recipients,active)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT(tenant_id,key,threshold_percent,channel) DO UPDATE SET recipients=EXCLUDED.recipients,active=EXCLUDED.active,updated_at=now()
      RETURNING *
    `,[tenantId,input.key,input.thresholdPercent,input.channel,JSON.stringify(input.recipients),input.active]);
    await audit({actorUserId:principal.userId,tenantId,action:"QUOTA_ALERT_UPSERTED",resourceType:"quota_alert",resourceId:row.rows[0].id,safeDiff:{key:input.key,thresholdPercent:input.thresholdPercent,channel:input.channel},request});
    reply.code(201).send({alert:row.rows[0]});
  });

  app.delete("/v1/tenants/:tenantId/quota-alerts/:alertId",async(request,reply)=>{
    const params=z.object({tenantId:z.string().uuid(),alertId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN"]);
    requireCsrf(request);
    const row=await query("DELETE FROM quota_alerts WHERE id=$1 AND tenant_id=$2 RETURNING id",[params.alertId,params.tenantId]);
    if(!row.rows[0]) throw new ApiError(404,"QUOTA_ALERT_NOT_FOUND","Quota alert not found.");
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,action:"QUOTA_ALERT_DELETED",resourceType:"quota_alert",resourceId:params.alertId,request});
    reply.send({ok:true});
  });

  app.get("/v1/tenants/:tenantId/ai/registry",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId);
    const result=await query("SELECT id,provider,model,display_name,capabilities,context_window,max_output_tokens,pricing_json,metadata FROM ai_model_registry WHERE active=true ORDER BY provider,display_name,model");
    reply.send({models:result.rows});
  });

  app.get("/v1/tenants/:tenantId/agent-templates",async(request,reply)=>{
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    await requireTenant(request,tenantId);
    const result=await query("SELECT id,key,name,description,capabilities,sections_json FROM prompt_templates WHERE active=true ORDER BY name");
    reply.send({templates:result.rows});
  });

  app.get("/v1/admin/ai-model-registry",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const result=await query("SELECT * FROM ai_model_registry ORDER BY provider,model");
    reply.send({models:result.rows});
  });

  app.put("/v1/admin/ai-model-registry/:provider/:model",async(request,reply)=>{
    const principal=await requirePlatformAdmin(request);requireCsrf(request);
    const params=z.object({provider:z.string().min(1).max(80),model:z.string().min(1).max(200)}).parse(request.params);
    const input=z.object({displayName:z.string().max(200).nullable().optional(),capabilities:z.array(z.string().max(80)).max(30).default([]),contextWindow:z.number().int().positive().nullable().optional(),maxOutputTokens:z.number().int().positive().nullable().optional(),pricing:z.record(z.string(),z.unknown()).default({}),metadata:z.record(z.string(),z.unknown()).default({}),active:z.boolean().default(true)}).parse(request.body);
    const row=await query<any>(`
      INSERT INTO ai_model_registry(provider,model,display_name,capabilities,context_window,max_output_tokens,pricing_json,metadata,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
      ON CONFLICT(provider,model) DO UPDATE SET display_name=EXCLUDED.display_name,capabilities=EXCLUDED.capabilities,
        context_window=EXCLUDED.context_window,max_output_tokens=EXCLUDED.max_output_tokens,pricing_json=EXCLUDED.pricing_json,
        metadata=EXCLUDED.metadata,active=EXCLUDED.active,updated_at=now()
      RETURNING *
    `,[params.provider,params.model,input.displayName??null,input.capabilities,input.contextWindow??null,input.maxOutputTokens??null,JSON.stringify(input.pricing),JSON.stringify(input.metadata),input.active]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"AI_MODEL_REGISTRY_UPSERTED",resourceType:"ai_model_registry",resourceId:row.rows[0].id,safeDiff:{provider:params.provider,model:params.model,active:input.active},request});
    reply.send({model:row.rows[0]});
  });

  app.get("/v1/admin/prompt-templates",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const result=await query("SELECT * FROM prompt_templates ORDER BY name");
    reply.send({templates:result.rows});
  });

  app.post("/v1/admin/prompt-templates",async(request,reply)=>{
    const principal=await requirePlatformAdmin(request);requireCsrf(request);
    const input=z.object({key:z.string().regex(/^[a-z0-9_-]+$/).max(100),name:z.string().min(1).max(160),description:z.string().max(1000).nullable().optional(),capabilities:z.array(z.string().max(80)).max(50).default([]),sections:z.record(z.string(),z.unknown()).default({}),active:z.boolean().default(true)}).parse(request.body);
    const row=await query<any>(`
      INSERT INTO prompt_templates(key,name,description,capabilities,sections_json,active,created_by,updated_by)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7) RETURNING *
    `,[input.key,input.name,input.description??null,input.capabilities,JSON.stringify(input.sections),input.active,principal.userId]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PROMPT_TEMPLATE_CREATED",resourceType:"prompt_template",resourceId:row.rows[0].id,safeDiff:{key:input.key,name:input.name},request});
    reply.code(201).send({template:row.rows[0]});
  });

  app.patch("/v1/admin/prompt-templates/:templateId",async(request,reply)=>{
    const principal=await requirePlatformAdmin(request);requireCsrf(request);
    const {templateId}=z.object({templateId:z.string().uuid()}).parse(request.params);
    const input=z.object({name:z.string().min(1).max(160).optional(),description:z.string().max(1000).nullable().optional(),capabilities:z.array(z.string().max(80)).max(50).optional(),sections:z.record(z.string(),z.unknown()).optional(),active:z.boolean().optional()}).parse(request.body);
    const row=await query<any>(`
      UPDATE prompt_templates SET name=COALESCE($2,name),description=CASE WHEN $3::boolean THEN $4 ELSE description END,
        capabilities=COALESCE($5,capabilities),sections_json=CASE WHEN $6::jsonb IS NULL THEN sections_json ELSE $6::jsonb END,
        active=COALESCE($7,active),updated_by=$8,updated_at=now() WHERE id=$1 RETURNING *
    `,[templateId,input.name??null,Object.prototype.hasOwnProperty.call(input,"description"),input.description??null,input.capabilities??null,input.sections?JSON.stringify(input.sections):null,input.active??null,principal.userId]);
    if(!row.rows[0]) throw new ApiError(404,"PROMPT_TEMPLATE_NOT_FOUND","Prompt template not found.");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PROMPT_TEMPLATE_UPDATED",resourceType:"prompt_template",resourceId:templateId,safeDiff:input,request});
    reply.send({template:row.rows[0]});
  });

  app.get("/v1/admin/plan-prices",async(request,reply)=>{
    await requirePlatformAdmin(request);
    const rows=await query(`SELECT pp.*,p.key AS plan_key,p.name AS plan_name FROM plan_prices pp JOIN plans p ON p.id=pp.plan_id ORDER BY p.name,pp.billing_interval,pp.currency`);
    reply.send({prices:rows.rows});
  });

  app.put("/v1/admin/plans/:planId/prices",async(request,reply)=>{
    const principal=await requirePlatformAdmin(request);requireCsrf(request);
    const {planId}=z.object({planId:z.string().uuid()}).parse(request.params);
    const input=z.object({billingInterval:z.enum(["month","year","one_time"]),currency:z.string().length(3).transform(v=>v.toUpperCase()),unitAmount:z.number().nonnegative(),provider:z.string().max(80).nullable().optional(),externalPriceId:z.string().max(240).nullable().optional(),active:z.boolean().default(true),metadata:z.record(z.string(),z.unknown()).default({})}).parse(request.body);
    const plan=await query("SELECT id FROM plans WHERE id=$1",[planId]);if(!plan.rows[0])throw new ApiError(404,"PLAN_NOT_FOUND","Plan not found.");
    const row=await query<any>(`
      INSERT INTO plan_prices(plan_id,billing_interval,currency,unit_amount,provider,external_price_id,active,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(plan_id,billing_interval,currency) DO UPDATE SET unit_amount=EXCLUDED.unit_amount,provider=EXCLUDED.provider,external_price_id=EXCLUDED.external_price_id,active=EXCLUDED.active,metadata=EXCLUDED.metadata,updated_at=now()
      RETURNING *
    `,[planId,input.billingInterval,input.currency,input.unitAmount,input.provider??null,input.externalPriceId??null,input.active,JSON.stringify(input.metadata)]);
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLAN_PRICE_UPSERTED",resourceType:"plan_price",resourceId:row.rows[0].id,safeDiff:{planId,billingInterval:input.billingInterval,currency:input.currency,unitAmount:input.unitAmount},request});
    reply.send({price:row.rows[0]});
  });
}
