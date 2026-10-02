import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  enqueue,
  env,
  mediaApiKeyForAsset,
  query,
  QUEUES,
  randomToken,
  transaction,
  type ResponsePlan,
} from "@n8n-automation/core";
import { analyzeImages, chat, embedding, transcribeAudio, type BinaryAiInput } from "../ai-provider.js";
import { ApiError, requestId, safeSecretEqual } from "../lib.js";
import { findConversationItems, isCatalogMediaRequest, isSpecificCatalogMediaRequest } from "../catalog-lookup.js";
import { buildGroundedCatalogResponse } from "../catalog-response.js";
import { orderActionContract } from "../action-contracts.js";
import { assertMonthlyUsageLimit, maxImagesPerResponse } from "../limits.js";
import { assertDailyAiAllowance, recordPlatformAiUsage, resolvePlatformModels, type PlatformAiModel } from "../platform-ai.js";

function requireInternal(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!safeSecretEqual(token, env().INTERNAL_SERVICE_AUTH_SECRET)) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Internal service authentication is required.");
}

async function runtimeContext(turnId: string) {
  const turn = await query<any>(`
    SELECT t.*,cv.business_id,cv.channel_account_id,cv.contact_id,cv.mode,cv.status AS conversation_status,cv.agent_profile_id,cv.state_version,
      ca.platform,ca.external_account_id,ca.settings_json AS channel_settings,b.name AS business_name,b.settings_json AS business_settings,
      a.name AS agent_name,a.capabilities,a.behavior_settings,a.active_prompt_version_id,
      pv.assembled_prompt,pv.sections_json,pv.version AS prompt_version
    FROM conversation_turns t
    JOIN conversations cv ON cv.id=t.conversation_id
    JOIN channel_accounts ca ON ca.id=cv.channel_account_id
    JOIN businesses b ON b.id=cv.business_id
    LEFT JOIN agent_profiles a ON a.id=cv.agent_profile_id
    LEFT JOIN prompt_versions pv ON pv.id=a.active_prompt_version_id
    WHERE t.id=$1
  `, [turnId]);
  const row = turn.rows[0];
  if (!row) throw new ApiError(404, "TURN_NOT_FOUND", "Conversation turn not found.");
  const messages = await query(`
    SELECT id,sender_type,message_type,text_content,metadata,created_at
    FROM messages WHERE turn_id=$1 AND tenant_id=$2 ORDER BY created_at
  `, [turnId, row.tenant_id]);
  const recent = await query(`
    SELECT sender_type,text_content,message_type,created_at
    FROM messages WHERE conversation_id=$1 AND tenant_id=$3 AND created_at < $2
    ORDER BY created_at DESC LIMIT 20
  `, [row.conversation_id, row.created_at, row.tenant_id]);
  const schemas = row.agent_profile_id ? await query(`
    SELECT c.id,c.name,c.key,c.purpose,c.schema_version,
      COALESCE(jsonb_agg(jsonb_build_object('key',f.key,'label',f.label,'type',f.type,'required',f.required,'aiVisible',f.ai_visible,'options',f.options_json) ORDER BY f.display_order) FILTER (WHERE f.id IS NOT NULL),'[]'::jsonb) AS fields
    FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id
    JOIN collection_channel_links ccl ON ccl.collection_id=c.id AND ccl.channel_account_id=$4
      AND ccl.tenant_id=$2 AND ccl.active=true
    LEFT JOIN collection_fields f ON f.collection_id=c.id AND f.tenant_id=$2 AND f.ai_visible=true
    WHERE acl.agent_profile_id=$1 AND acl.tenant_id=$2 AND c.tenant_id=$2 AND c.business_id=$3 AND c.status='active'
    GROUP BY c.id,c.name,c.key,c.purpose,c.schema_version ORDER BY max(acl.priority) DESC
  `, [row.agent_profile_id, row.tenant_id, row.business_id, row.channel_account_id]) : { rows: [] } as any;
  const media = await query<any>(`
    SELECT mm.message_id,ma.id AS asset_id,ma.storage_file_id,ma.storage_user_id,ma.original_name,ma.mime_type,ma.kind,ma.size_bytes,ma.visibility
    FROM message_media mm
    JOIN media_assets ma ON ma.id=mm.media_asset_id
    JOIN messages m ON m.id=mm.message_id
    WHERE m.turn_id=$1 AND m.tenant_id=$2 AND ma.tenant_id=$2
      AND ma.processing_status='ready'
      AND COALESCE(ma.metadata->>'source','') NOT IN ('tenant_export','collection_export')
      AND (ma.business_id IS NULL OR ma.business_id=$3)
    ORDER BY m.created_at,mm.display_order
  `, [turnId, row.tenant_id, row.business_id]);
  return { row, messages: messages.rows, recent: recent.rows.reverse(), schemas: schemas.rows, media: media.rows };
}

async function findKnowledge(tenantId: string, businessId: string, agentId: string | null, channelId: string, text: string, turnId: string) {
  if (!text.trim()) return [];
  try {
    const model = await resolveModel(tenantId, businessId, agentId, channelId, "EMBEDDINGS");
    if (model) {
      const embedded = await embedding(model, { model: model.model, parameters: model.parameters ?? {} }, text.slice(0, 8000));
      await recordPlatformAiUsage({tenantId,businessId,channelAccountId:channelId,eventType:"ai_call",unit:"call",taskKey:"EMBEDDINGS",model,usage:embedded.usage,idempotencyKey:`turn-embedding:${turnId}`,metadata:{operation:"conversation_rag"}});
      if (embedded.vector.length === env().EMBEDDING_DIMENSIONS) {
        const vector = `[${embedded.vector.join(",")}]`;
        const result = await query(`
          SELECT kc.id,kc.source_id,kc.content,kc.metadata,ks.title,ks.type,
                 1-(kc.embedding <=> $4::vector) AS similarity
          FROM knowledge_chunks kc
          JOIN knowledge_sources ks ON ks.id=kc.source_id
          WHERE kc.tenant_id=$1 AND kc.business_id=$2 AND ks.tenant_id=$1 AND ks.business_id=$2
            AND kc.active=true AND ks.status='ready'
            AND (ks.agent_profile_id IS NULL OR ks.agent_profile_id=$3)
          ORDER BY kc.embedding <=> $4::vector
          LIMIT 8
        `, [tenantId,businessId,agentId,vector]);
        return result.rows;
      }
    }
  } catch (error) {
    if (error instanceof ApiError && ["AI_TOKEN_LIMIT_REACHED","AI_CREDIT_LIMIT_REACHED"].includes(error.code)) throw error;
    // Keyword fallback keeps the conversation available when embedding search is degraded.
  }
  const result = await query(`
    SELECT ks.id,ks.title,ks.type,left(ks.content,3000) AS content
    FROM knowledge_sources ks
    WHERE ks.tenant_id=$1 AND ks.business_id=$2 AND ks.status='ready'
      AND (ks.agent_profile_id IS NULL OR ks.agent_profile_id=$3)
      AND (ks.title ILIKE '%'||$4||'%' OR ks.content ILIKE '%'||$4||'%')
    ORDER BY ks.updated_at DESC LIMIT 8
  `, [tenantId, businessId, agentId, text.slice(0, 200)]);
  return result.rows;
}

async function readMedia(tenantId: string, item: any): Promise<BinaryAiInput> {
  const mediaBaseUrl = env().MEDIA_BASE_URL;
  if (!mediaBaseUrl) throw new Error("MEDIA_BASE_URL is not configured");
  if (Number(item.size_bytes ?? 0) > 25 * 1024 * 1024) throw new Error("AI media input exceeds the 25 MiB runtime limit");
  const credential = await mediaApiKeyForAsset(tenantId, item.storage_user_id);
  const response = await fetch(`${mediaBaseUrl.replace(/\/$/, "")}/api/v1/files/${encodeURIComponent(item.storage_file_id)}/content`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error(`Media fetch failed with ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || item.mime_type || "application/octet-stream",
    filename: item.original_name || undefined,
  };
}

async function multimodalContext(context: any, maxImages = 20) {
  const row = context.row;
  const images = (context.media ?? [])
    .filter((item: any) => item.kind === "image" || String(item.mime_type).startsWith("image/"))
    .slice(0,Math.max(1,Math.min(20,maxImages)));
  const audio = (context.media ?? []).find((item: any) => item.kind === "audio" || String(item.mime_type).startsWith("audio/"));
  const result: { imageAnalysis?: string; transcript?: string; usage: Array<{task:string;model:PlatformAiModel;usage:any}> } = { usage: [] };

  if (images.length) {
    const model = await resolveModel(row.tenant_id,row.business_id,row.agent_profile_id,row.channel_account_id,"IMAGE_ANALYSIS");
    if (model) {
      const binaries: BinaryAiInput[] = [];
      for (const image of images) binaries.push(await readMedia(row.tenant_id,image));
      const analysis = await analyzeImages(model,{model:model.model,parameters:model.parameters ?? {}},
        "Analyze these customer-provided screenshots/images for business matching. Extract visible product/service names, text, SKU, category, colors, sizes, distinguishing attributes, and the user's likely intent. Do not invent price, stock, availability, or policy. Return concise searchable observations.",binaries);
      result.imageAnalysis = analysis.text;
      result.usage.push({ task: "IMAGE_ANALYSIS", model, usage: analysis.usage });
    }
  }

  if (audio) {
    const model = await resolveModel(row.tenant_id,row.business_id,row.agent_profile_id,row.channel_account_id,"AUDIO_TRANSCRIPTION");
    if (model) {
      const binary = await readMedia(row.tenant_id,audio);
      const transcript = await transcribeAudio(model,{model:model.model,parameters:model.parameters ?? {}},binary);
      result.transcript = transcript.text;
      result.usage.push({ task: "AUDIO_TRANSCRIPTION", model, usage: transcript.usage });
    }
  }
  return result;
}

async function resolveModels(tenantId: string, _businessId: string, _agentId: string | null, _channelId: string, taskKey: string) {
  await assertDailyAiAllowance(tenantId);
  return resolvePlatformModels(taskKey,5);
}

async function resolveModel(tenantId: string, businessId: string, agentId: string | null, channelId: string, taskKey: string) {
  return (await resolveModels(tenantId,businessId,agentId,channelId,taskKey))[0] ?? null;
}

export async function internalRoutes(app: FastifyInstance) {
  app.get("/v1/internal/runtime/turn/:turnId", async (request, reply) => {
    requireInternal(request);
    const { turnId } = z.object({ turnId: z.string().uuid() }).parse(request.params);
    const context = await runtimeContext(turnId);
    reply.send({
      turn: context.row,
      messages: context.messages,
      recentMessages: context.recent,
      collectionSchemas: context.schemas,
      media: context.media,
    });
  });

  app.post("/v1/internal/ai/respond", async (request, reply) => {
    requireInternal(request);
    const input = z.object({ turnId: z.string().uuid() }).parse(request.body);
    const context = await runtimeContext(input.turnId);
    const row = context.row;
    const training = await query(`SELECT id FROM training_sessions WHERE channel_account_id=$1 AND (
      status='open' OR created_at >= $2::timestamptz OR
      (created_at <= $2::timestamptz AND stopped_at>$2::timestamptz)
    ) LIMIT 1`,[row.channel_account_id,row.created_at]);
    if (training.rows[0]) throw new ApiError(409,"AI_SUPPRESSED_BY_TRAINING","AI responses are paused while channel training is on.");
    await assertMonthlyUsageLimit(row.tenant_id, "ai_call", "aiTurnsPerMonth");
    await assertDailyAiAllowance(row.tenant_id);
    if (row.mode !== "AI" || row.conversation_status !== "open") throw new ApiError(409, "CONVERSATION_NOT_AI_ELIGIBLE", "Conversation is not eligible for an AI response.");
    if (!row.agent_profile_id || !row.active_prompt_version_id) throw new ApiError(409, "AGENT_NOT_CONFIGURED", "Conversation has no active AI agent/prompt.");
    const originalTurnText = context.messages.map((message: any) => message.text_content).filter(Boolean).join("\n");
    const imageLimit = await maxImagesPerResponse(row.tenant_id,row.channel_account_id);
    const multimodal = await multimodalContext(context,20);
    for (const [index, extra] of multimodal.usage.entries()) {
      await recordPlatformAiUsage({tenantId:row.tenant_id,businessId:row.business_id,channelAccountId:row.channel_account_id,conversationId:row.conversation_id,eventType:"ai_call",unit:"call",taskKey:extra.task,model:extra.model,usage:extra.usage,correlationId:requestId(request),idempotencyKey:`ai-extra:${input.turnId}:${index}:${extra.task}`});
    }
    const turnText = [originalTurnText, multimodal.transcript, multimodal.imageAnalysis].filter(Boolean).join("\n\n");
    const items = await findConversationItems(row.tenant_id, row.business_id, row.agent_profile_id, row.channel_account_id,
      turnText, context.recent.map((message: any) => String(message.text_content ?? "")));
    const knowledge = await findKnowledge(row.tenant_id, row.business_id, row.agent_profile_id, row.channel_account_id, turnText, input.turnId);
    const modelCandidates = await resolveModels(row.tenant_id, row.business_id, row.agent_profile_id, row.channel_account_id, "DEFAULT_CHAT");
    if (!modelCandidates.length) throw new ApiError(409, "AI_MODEL_MISSING", "No platform DEFAULT_CHAT model is configured.");
    const system = [
      row.assembled_prompt || "You are a helpful business assistant.",
      "\n## Runtime rules\nUse only current provided business facts. If facts are missing, say they are unavailable. Never invent prices, stock, booking availability, or policy. Only request/perform capabilities listed below.",
      `\nCapabilities: ${JSON.stringify(row.capabilities || [])}`,
      orderActionContract(row.capabilities),
      `\nCollection schemas: ${JSON.stringify(context.schemas)}`,
      `\nRelevant current items: ${JSON.stringify(items)}`,
      `\nRelevant knowledge: ${JSON.stringify(knowledge)}`,
      multimodal.transcript ? `\nAudio transcript: ${multimodal.transcript}` : "",
      multimodal.imageAnalysis ? `\nImage observations: ${multimodal.imageAnalysis}` : "",
      "\nOnly Relevant current items[].media[].assetId values are approved for catalog media replies. When the customer explicitly asks for a product photo or image, include appropriate approved media messages; never invent, copy from hidden fields, or guess an asset ID. The server may add other approved catalog images up to the configured limit.",
      "\nRespond as strict JSON with keys: messages (array of {type:'text',text:string} or {type:'media',assetId:string,caption?:string}), actions (array of {tool:string,arguments:object}), handoff (boolean), handoffReason (string|null). Keep responses concise and grounded.",
    ].join("\n");
    const history = context.recent.filter((message: any) => message.text_content).map((message: any) => ({
      role: message.sender_type === "CONTACT" || message.sender_type === "TRAINER" ? "user" as const : "assistant" as const,
      content: message.text_content,
    }));
    history.push({ role: "user", content: originalTurnText || multimodal.transcript || multimodal.imageAnalysis || "[The user sent media without text.]" });
    let result:any=null;let model:PlatformAiModel|null=null;let lastModelError:unknown=null;
    for (const candidate of modelCandidates) {
      try {
        result = await chat(candidate,{model:candidate.model,parameters:candidate.parameters??{}},{system,messages:history});
        model=candidate;break;
      } catch (error) {
        lastModelError=error;
        const status=Number((error as any)?.status||0);
        if(status>=400 && status<500 && ![408,409,429].includes(status)) break;
      }
    }
    if(!result||!model) throw lastModelError instanceof Error ? lastModelError : new ApiError(502,"AI_PROVIDER_UNAVAILABLE","No configured platform AI fallback model could produce a response.");
    let parsed: any;
    try {
      const clean = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(clean);
    } catch {
      parsed = { messages: [{ type: "text", text: result.text.trim() || "I’m unable to answer that right now." }], actions: [], handoff: false, handoffReason: null };
    }
    const messages = buildGroundedCatalogResponse({
      rawMessages:Array.isArray(parsed.messages) ? parsed.messages : [],
      items,
      explicitMediaRequest:isCatalogMediaRequest(originalTurnText),
      specificMediaRequest:isSpecificCatalogMediaRequest(originalTurnText),
      imageLimit,
      totalMessageLimit:20,
    });
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
    if (!messages.length && !parsed.handoff) messages.push({ type: "text", text: "I’m unable to answer that right now. A team member can help if needed." });
    await recordPlatformAiUsage({tenantId:row.tenant_id,businessId:row.business_id,channelAccountId:row.channel_account_id,conversationId:row.conversation_id,eventType:"ai_call",unit:"call",taskKey:"DEFAULT_CHAT",model,usage:result.usage,correlationId:requestId(request),idempotencyKey:`ai:${input.turnId}:${row.active_prompt_version_id}`});
    const stillEligible = await query<{mode:string;status:string;state_version:string}>(
      "SELECT mode,status,state_version FROM conversations WHERE id=$1 AND tenant_id=$2",[row.conversation_id,row.tenant_id]);
    const nowTraining = await query(`SELECT id FROM training_sessions WHERE channel_account_id=$1 AND (
      status='open' OR created_at >= $2::timestamptz OR
      (created_at <= $2::timestamptz AND stopped_at>$2::timestamptz)
    ) LIMIT 1`,[row.channel_account_id,row.created_at]);
    if (nowTraining.rows[0] || stillEligible.rows[0]?.mode !== "AI" ||
        stillEligible.rows[0]?.status !== "open" || Number(stillEligible.rows[0]?.state_version) !== Number(row.state_version)) {
      throw new ApiError(409,"AI_SUPPRESSED_BY_TRAINING","The conversation changed while the AI response was generated.");
    }
    reply.send({
      turnId: input.turnId,
      tenantId: row.tenant_id,
      businessId: row.business_id,
      channelAccountId: row.channel_account_id,
      conversationId: row.conversation_id,
      stateVersion: row.state_version,
      agentProfileId: row.agent_profile_id,
      promptVersionId: row.active_prompt_version_id,
      messages,
      actions,
      handoff: Boolean(parsed.handoff),
      handoffReason: parsed.handoffReason ?? null,
      usage: result.usage,
    });
  });

  app.post("/v1/internal/actions/execute", async (request, reply) => {
    requireInternal(request);
    const input = z.object({
      tenantId: z.string().uuid(),
      businessId: z.string().uuid(),
      channelAccountId: z.string().uuid(),
      conversationId: z.string().uuid(),
      tool: z.enum(["create_order", "create_booking", "create_lead", "create_quote_request", "create_support_case", "schedule_followup", "handoff_conversation"]),
      arguments: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().min(1).max(300),
    }).parse(request.body);
    const conversation = await query<any>("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND channel_account_id=$4", [input.conversationId, input.tenantId, input.businessId, input.channelAccountId]);
    if (!conversation.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    const agent = conversation.rows[0].agent_profile_id
      ? await query<{ capabilities: string[] }>(
        "SELECT capabilities FROM agent_profiles WHERE id=$1 AND tenant_id=$2 AND business_id=$3",
        [conversation.rows[0].agent_profile_id, input.tenantId, input.businessId],
      )
      : { rows: [] } as any;
    const capabilityMap: Record<string, string> = { create_order: "ORDER_CREATE", create_booking: "BOOKING_CREATE", create_lead: "LEAD_CAPTURE", create_quote_request: "QUOTE_REQUEST", create_support_case: "SUPPORT_CASE", schedule_followup: "FOLLOW_UP", handoff_conversation: "HUMAN_HANDOFF" };
    if (!agent.rows[0]?.capabilities?.includes(capabilityMap[input.tool])) throw new ApiError(403, "CAPABILITY_DISABLED", `Capability ${capabilityMap[input.tool]} is not enabled.`);
    const existing = await query<{ response_json: any; status: string }>("SELECT response_json,status FROM idempotency_keys WHERE tenant_id=$1 AND scope='agent_action' AND key=$2", [input.tenantId, input.idempotencyKey]);
    if (existing.rows[0]?.status === "completed") return reply.send(existing.rows[0].response_json);
    const turnId = input.idempotencyKey.match(/^turn:([0-9a-fA-F-]{36}):/)?.[1];
    if (!turnId || !z.string().uuid().safeParse(turnId).success) {
      throw new ApiError(400,"ACTION_TURN_REQUIRED","An AI action must identify its source turn.");
    }
    const sourceTurn = await query<{created_at:Date}>(
      "SELECT created_at FROM conversation_turns WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3",
      [turnId,input.tenantId,input.conversationId]);
    if (!sourceTurn.rows[0]) throw new ApiError(404,"TURN_NOT_FOUND","Source turn not found.");
    const training = await query(`SELECT id FROM training_sessions WHERE channel_account_id=$1 AND (
      status='open' OR created_at >= $2::timestamptz OR
      (created_at <= $2::timestamptz AND stopped_at>$2::timestamptz)
    ) LIMIT 1`,[input.channelAccountId,sourceTurn.rows[0].created_at]);
    if (conversation.rows[0].mode !== "AI" || conversation.rows[0].status !== "open" || training.rows[0]) {
      throw new ApiError(409,"AI_SUPPRESSED_BY_TRAINING","AI actions are paused while channel training is on or the source turn is stale.");
    }
    if (input.tool === "schedule_followup") {
      const delayMinutes = Math.max(1, Math.min(60 * 24 * 30, Number(input.arguments.delayMinutes ?? 60)));
      const message = String(input.arguments.message ?? "").trim();
      if (!message) throw new ApiError(400,"FOLLOWUP_MESSAGE_REQUIRED","Follow-up message is required.");
      const created = await query<any>(`
        INSERT INTO followup_jobs(tenant_id,business_id,channel_account_id,conversation_id,agent_profile_id,due_at,policy_snapshot,idempotency_key)
        VALUES ($1,$2,$3,$4,$5,now()+($6 || ' minutes')::interval,$7::jsonb,$8)
        ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=now()
        RETURNING *
      `,[input.tenantId,input.businessId,input.channelAccountId,input.conversationId,conversation.rows[0].agent_profile_id,String(delayMinutes),JSON.stringify({message,maxWindowHours:Number(input.arguments.maxWindowHours ?? 23),source:"ai"}),input.idempotencyKey]);
      const response={tool:input.tool,followup:created.rows[0]};
      await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status,response_json) VALUES ($1,'agent_action',$2,'completed',$3::jsonb) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='completed',response_json=EXCLUDED.response_json,updated_at=now()`,[input.tenantId,input.idempotencyKey,JSON.stringify(response)]);
      return reply.send(response);
    }
    if (input.tool === "handoff_conversation") {
      const updated = await query("UPDATE conversations SET mode='HUMAN',state_version=state_version+1,escalation_metadata=escalation_metadata||$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *", [input.conversationId, JSON.stringify({ aiHandoffReason: input.arguments.reason ?? null })]);
      const response = { tool: input.tool, conversation: updated.rows[0] };
      await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status,response_json) VALUES ($1,'agent_action',$2,'completed',$3::jsonb) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='completed',response_json=EXCLUDED.response_json,updated_at=now()`, [input.tenantId, input.idempotencyKey, JSON.stringify(response)]);
      return reply.send(response);
    }
    const endpoint = input.tool === "create_order" ? "orders" : input.tool === "create_booking" ? "bookings" : input.tool === "create_lead" ? "leads" : input.tool === "create_quote_request" ? "quotes" : "support-cases";
    // One confirmation turn represents one order, even if the model repeats the
    // tool at different action indexes or a retry changes their order.
    const persistenceKey = input.tool === "create_order" ? `turn:${turnId}:create_order` : input.idempotencyKey;
    const response = await fetch(`${env().API_PUBLIC_ORIGIN}/v1/tenants/${input.tenantId}/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env().INTERNAL_SERVICE_AUTH_SECRET}`, "content-type": "application/json", "idempotency-key": persistenceKey },
      body: JSON.stringify({ ...input.arguments, businessId: input.businessId, channelAccountId: input.channelAccountId, conversationId: input.conversationId, contactId: conversation.rows[0].contact_id,
        ...(input.tool === "create_order" ? { source: "ai" } : {}) }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, "ACTION_EXECUTION_FAILED", `Action ${input.tool} failed.`, body);
    const result = { tool: input.tool, result: body };
    await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status,response_json) VALUES ($1,'agent_action',$2,'completed',$3::jsonb) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='completed',response_json=EXCLUDED.response_json,updated_at=now()`, [input.tenantId, input.idempotencyKey, JSON.stringify(result)]);
    reply.send(result);
  });

  app.post("/v1/internal/outbound/enqueue", async (request, reply) => {
    requireInternal(request);
    const input = z.object({
      tenantId: z.string().uuid(),
      businessId: z.string().uuid(),
      channelAccountId: z.string().uuid(),
      conversationId: z.string().uuid(),
      stateVersion: z.number().int().positive().optional(),
      messages: z.array(z.union([z.object({ type: z.literal("text"), text: z.string().min(1).max(20000) }), z.object({ type: z.literal("media"), assetId: z.string().uuid(), caption: z.string().max(2000).nullable().optional() })])).min(1).max(20),
      priority: z.enum(["HUMAN", "TRANSACTIONAL", "CUSTOMER_ACTIVE", "NORMAL", "FOLLOWUP"]).default("CUSTOMER_ACTIVE"),
      senderType: z.enum(["AI", "HUMAN", "SYSTEM"]).default("AI"),
      logicalResponseId: z.string().min(1).max(200).optional(),
    }).parse(request.body);
    const cv = await query<any>("SELECT mode,state_version,business_id FROM conversations WHERE id=$1 AND tenant_id=$2 AND channel_account_id=$3", [input.conversationId, input.tenantId, input.channelAccountId]);
    if (!cv.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    if (cv.rows[0].business_id !== input.businessId) throw new ApiError(400, "BUSINESS_SCOPE_INVALID", "Conversation does not belong to the selected business.");
    if (input.senderType === "AI" && cv.rows[0].mode !== "AI") throw new ApiError(409, "AI_SUPPRESSED_BY_MODE", "AI delivery is blocked because the conversation is not in AI mode.");
    if (input.senderType !== "HUMAN") {
      const training = await query("SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open' LIMIT 1",[input.channelAccountId]);
      if (training.rows[0]) throw new ApiError(409,"AI_SUPPRESSED_BY_TRAINING","AI delivery is paused while channel training is on.");
    }
    if (input.stateVersion && Number(cv.rows[0].state_version) !== input.stateVersion) throw new ApiError(409, "CONVERSATION_VERSION_CHANGED", "Conversation state changed while the response was being generated.");
    const logicalResponseId = input.logicalResponseId ?? randomToken(18);
    let i = 0;
    for (const message of input.messages) {
      if (message.type === "media") {
        const asset = await query<{ business_id: string | null; metadata: Record<string, unknown> | null }>("SELECT business_id,metadata FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status='ready'", [message.assetId, input.tenantId]);
        if (!asset.rows[0] || ["tenant_export", "collection_export"].includes(String(asset.rows[0].metadata?.source ?? "")) || (asset.rows[0].business_id && asset.rows[0].business_id !== input.businessId)) {
          throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset is unavailable for this business.");
        }
      }
      const sequenceIndex = i++;
      const jobId = `outbound:${logicalResponseId}:${sequenceIndex}`;
      const priorityMap={HUMAN:1,TRANSACTIONAL:2,CUSTOMER_ACTIVE:3,NORMAL:5,FOLLOWUP:8} as const;
      await enqueue(QUEUES.outbound, {
        jobId,
        jobType: "SEND_MESSAGE",
        tenantId: input.tenantId,
        businessId: input.businessId,
        channelAccountId: input.channelAccountId,
        conversationId: input.conversationId,
        correlationId: requestId(request),
        idempotencyKey: jobId,
        createdAt: new Date().toISOString(),
        payload: { logicalResponseId, sequenceIndex, sequenceLength:input.messages.length, priority: input.priority, senderType: input.senderType, message },
      }, { priority: priorityMap[input.priority] });
    }
    reply.code(202).send({ ok: true, logicalResponseId, queued: input.messages.length });
  });

  app.post("/v1/internal/turns/:turnId/complete", async (request, reply) => {
    requireInternal(request);
    const { turnId } = z.object({ turnId: z.string().uuid() }).parse(request.params);
    const input = z.object({ status: z.enum(["processed", "failed"]).default("processed"), metadata: z.record(z.string(), z.unknown()).default({}) }).parse(request.body ?? {});
    await query("UPDATE conversation_turns SET status=$2,metadata=metadata||$3::jsonb,processed_at=now() WHERE id=$1", [turnId, input.status, JSON.stringify(input.metadata)]);
    reply.send({ ok: true });
  });
}
