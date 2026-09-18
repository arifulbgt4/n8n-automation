import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  enqueue,
  env,
  query,
  QUEUES,
  randomToken,
  transaction,
  type ResponsePlan,
} from "@n8n-automation/core";
import { analyzeImages, chat, embedding, transcribeAudio, type BinaryAiInput } from "../ai-provider.js";
import { ApiError, requestId } from "../lib.js";
import { assertMonthlyUsageLimit, maxImagesPerResponse } from "../limits.js";

function requireInternal(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || token !== env().INTERNAL_SERVICE_AUTH_SECRET) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Internal service authentication is required.");
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
    FROM messages WHERE turn_id=$1 ORDER BY created_at
  `, [turnId]);
  const recent = await query(`
    SELECT sender_type,text_content,message_type,created_at
    FROM messages WHERE conversation_id=$1 AND created_at < $2
    ORDER BY created_at DESC LIMIT 20
  `, [row.conversation_id, row.created_at]);
  const schemas = row.agent_profile_id ? await query(`
    SELECT c.id,c.name,c.key,c.purpose,c.schema_version,
      COALESCE(jsonb_agg(jsonb_build_object('key',f.key,'label',f.label,'type',f.type,'required',f.required,'aiVisible',f.ai_visible,'options',f.options_json) ORDER BY f.display_order) FILTER (WHERE f.id IS NOT NULL),'[]'::jsonb) AS fields
    FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id
    LEFT JOIN collection_fields f ON f.collection_id=c.id
    WHERE acl.agent_profile_id=$1 AND c.status='active'
    GROUP BY c.id,c.name,c.key,c.purpose,c.schema_version ORDER BY max(acl.priority) DESC
  `, [row.agent_profile_id]) : { rows: [] } as any;
  const media = await query<any>(`
    SELECT mm.message_id,ma.id AS asset_id,ma.storage_file_id,ma.original_name,ma.mime_type,ma.kind,ma.size_bytes,ma.visibility
    FROM message_media mm
    JOIN media_assets ma ON ma.id=mm.media_asset_id
    JOIN messages m ON m.id=mm.message_id
    WHERE m.turn_id=$1 AND ma.processing_status='ready'
    ORDER BY m.created_at,mm.display_order
  `, [turnId]);
  return { row, messages: messages.rows, recent: recent.rows.reverse(), schemas: schemas.rows, media: media.rows };
}

async function findRelevantItems(tenantId: string, businessId: string, agentId: string | null, text: string) {
  if (!agentId || !text.trim()) return [];
  const words = text.toLowerCase().split(/\s+/).filter((word) => word.length >= 3).slice(0, 8);
  const needle = words.join(" ");
  if (!needle) return [];
  const result = await query(`
    SELECT i.id,i.collection_id,i.title,i.data_jsonb,c.name AS collection_name,c.purpose
    FROM collection_items i
    JOIN collections c ON c.id=i.collection_id
    JOIN agent_collection_links acl ON acl.collection_id=c.id AND acl.agent_profile_id=$3
    WHERE i.tenant_id=$1 AND i.business_id=$2 AND i.status='active'
      AND (i.title ILIKE '%'||$4||'%' OR i.data_jsonb::text ILIKE '%'||$4||'%' OR EXISTS (
        SELECT 1 FROM unnest(string_to_array($4,' ')) w WHERE length(w)>=3 AND (i.title ILIKE '%'||w||'%' OR i.data_jsonb::text ILIKE '%'||w||'%')
      ))
    ORDER BY i.updated_at DESC LIMIT 20
  `, [tenantId, businessId, agentId, needle]);
  return result.rows;
}

async function findKnowledge(tenantId: string, businessId: string, agentId: string | null, channelId: string, text: string) {
  if (!text.trim()) return [];
  try {
    const model = await resolveModel(tenantId, businessId, agentId, channelId, "EMBEDDINGS");
    if (model) {
      const embedded = await embedding(model, { model: model.model, parameters: model.parameters ?? {} }, text.slice(0, 8000));
      if (embedded.vector.length === env().EMBEDDING_DIMENSIONS) {
        const vector = `[${embedded.vector.join(",")}]`;
        const result = await query(`
          SELECT kc.id,kc.source_id,kc.content,kc.metadata,ks.title,ks.type,
                 1-(kc.embedding <=> $4::vector) AS similarity
          FROM knowledge_chunks kc
          JOIN knowledge_sources ks ON ks.id=kc.source_id
          WHERE kc.tenant_id=$1 AND kc.business_id=$2 AND kc.active=true AND ks.status='ready'
            AND (ks.agent_profile_id IS NULL OR ks.agent_profile_id=$3)
          ORDER BY kc.embedding <=> $4::vector
          LIMIT 8
        `, [tenantId,businessId,agentId,vector]);
        return result.rows;
      }
    }
  } catch {
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

async function mediaCredential(tenantId: string): Promise<string> {
  const result = await query<{ encrypted_api_key: string | null }>(
    "SELECT encrypted_api_key FROM tenant_media_accounts WHERE tenant_id=$1 AND status='active'",
    [tenantId],
  );
  if (result.rows[0]?.encrypted_api_key) {
    const { decryptSecret } = await import("@n8n-automation/core");
    return decryptSecret(result.rows[0].encrypted_api_key);
  }
  if (env().MEDIA_API_KEY) return env().MEDIA_API_KEY;
  throw new Error("Media credential is not configured");
}

async function readMedia(tenantId: string, item: any): Promise<BinaryAiInput> {
  if (!env().MEDIA_BASE_URL) throw new Error("MEDIA_BASE_URL is not configured");
  if (Number(item.size_bytes ?? 0) > 25 * 1024 * 1024) throw new Error("AI media input exceeds the 25 MiB runtime limit");
  const credential = await mediaCredential(tenantId);
  const response = await fetch(`${env().MEDIA_BASE_URL.replace(/\/$/, "")}/api/v1/files/${encodeURIComponent(item.storage_file_id)}/content`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error(`Media fetch failed with ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") || item.mime_type || "application/octet-stream",
    filename: item.original_name || undefined,
  };
}

async function multimodalContext(context: any) {
  const row = context.row;
  const images = (context.media ?? []).filter((item: any) => item.kind === "image" || String(item.mime_type).startsWith("image/")).slice(0, 5);
  const audio = (context.media ?? []).find((item: any) => item.kind === "audio" || String(item.mime_type).startsWith("audio/"));
  const result: { imageAnalysis?: string; transcript?: string; usage: unknown[] } = { usage: [] };

  if (images.length) {
    const model = await resolveModel(row.tenant_id,row.business_id,row.agent_profile_id,row.channel_account_id,"IMAGE_ANALYSIS");
    if (model) {
      const binaries: BinaryAiInput[] = [];
      for (const image of images) binaries.push(await readMedia(row.tenant_id,image));
      const analysis = await analyzeImages(model,{model:model.model,parameters:model.parameters ?? {}},
        "Analyze these customer-provided screenshots/images for business matching. Extract visible product/service names, text, SKU, category, colors, sizes, distinguishing attributes, and the user's likely intent. Do not invent price, stock, availability, or policy. Return concise searchable observations.",binaries);
      result.imageAnalysis = analysis.text;
      result.usage.push({ task: "IMAGE_ANALYSIS", provider: model.provider, model: model.model, usage: analysis.usage });
    }
  }

  if (audio) {
    const model = await resolveModel(row.tenant_id,row.business_id,row.agent_profile_id,row.channel_account_id,"AUDIO_TRANSCRIPTION");
    if (model) {
      const binary = await readMedia(row.tenant_id,audio);
      const transcript = await transcribeAudio(model,{model:model.model,parameters:model.parameters ?? {}},binary);
      result.transcript = transcript.text;
      result.usage.push({ task: "AUDIO_TRANSCRIPTION", provider: model.provider, model: model.model, usage: transcript.usage });
    }
  }
  return result;
}

async function resolveModel(tenantId: string, businessId: string, agentId: string | null, channelId: string, taskKey: string) {
  const result = await query<any>(`
    SELECT m.id,m.model,m.parameters,p.provider,p.encrypted_api_key,p.base_url,p.id AS provider_connection_id
    FROM ai_model_configs m JOIN ai_provider_connections p ON p.id=m.provider_connection_id
    WHERE m.tenant_id=$1 AND m.active=true AND p.status='active'
      AND m.task_key=$5
      AND (m.business_id=$2 OR m.business_id IS NULL)
      AND (m.agent_profile_id=$3 OR m.agent_profile_id IS NULL)
      AND (m.channel_account_id=$4 OR m.channel_account_id IS NULL)
    ORDER BY (m.channel_account_id IS NOT NULL) DESC,(m.agent_profile_id IS NOT NULL) DESC,(m.business_id IS NOT NULL) DESC,m.created_at DESC
    LIMIT 1
  `, [tenantId, businessId, agentId, channelId, taskKey]);
  return result.rows[0] ?? null;
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
    await assertMonthlyUsageLimit(row.tenant_id, "ai_call", "aiTurnsPerMonth");
    if (row.mode !== "AI" || row.conversation_status !== "open") throw new ApiError(409, "CONVERSATION_NOT_AI_ELIGIBLE", "Conversation is not eligible for an AI response.");
    if (!row.agent_profile_id || !row.active_prompt_version_id) throw new ApiError(409, "AGENT_NOT_CONFIGURED", "Conversation has no active AI agent/prompt.");
    const originalTurnText = context.messages.map((message: any) => message.text_content).filter(Boolean).join("\n");
    const multimodal = await multimodalContext(context);
    const turnText = [originalTurnText, multimodal.transcript, multimodal.imageAnalysis].filter(Boolean).join("\n\n");
    const items = await findRelevantItems(row.tenant_id, row.business_id, row.agent_profile_id, turnText);
    const knowledge = await findKnowledge(row.tenant_id, row.business_id, row.agent_profile_id, row.channel_account_id, turnText);
    const model = await resolveModel(row.tenant_id, row.business_id, row.agent_profile_id, row.channel_account_id, "DEFAULT_CHAT");
    if (!model) throw new ApiError(409, "AI_MODEL_MISSING", "No DEFAULT_CHAT model is configured for this agent.");
    const system = [
      row.assembled_prompt || "You are a helpful business assistant.",
      "\n## Runtime rules\nUse only current provided business facts. If facts are missing, say they are unavailable. Never invent prices, stock, booking availability, or policy. Only request/perform capabilities listed below.",
      `\nCapabilities: ${JSON.stringify(row.capabilities || [])}`,
      `\nCollection schemas: ${JSON.stringify(context.schemas)}`,
      `\nRelevant current items: ${JSON.stringify(items)}`,
      `\nRelevant knowledge: ${JSON.stringify(knowledge)}`,
      multimodal.transcript ? `\nAudio transcript: ${multimodal.transcript}` : "",
      multimodal.imageAnalysis ? `\nImage observations: ${multimodal.imageAnalysis}` : "",
      "\nRespond as strict JSON with keys: messages (array of {type:'text',text:string} or {type:'media',assetId:string}), actions (array of {tool:string,arguments:object}), handoff (boolean), handoffReason (string|null). Keep responses concise and grounded.",
    ].join("\n");
    const history = context.recent.filter((message: any) => message.text_content).map((message: any) => ({
      role: message.sender_type === "CONTACT" || message.sender_type === "TRAINER" ? "user" as const : "assistant" as const,
      content: message.text_content,
    }));
    history.push({ role: "user", content: originalTurnText || multimodal.transcript || multimodal.imageAnalysis || "[The user sent media without text.]" });
    const result = await chat(model, { model: model.model, parameters: model.parameters ?? {} }, { system, messages: history });
    let parsed: any;
    try {
      const clean = result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      parsed = JSON.parse(clean);
    } catch {
      parsed = { messages: [{ type: "text", text: result.text.trim() || "I’m unable to answer that right now." }], actions: [], handoff: false, handoffReason: null };
    }
    const rawMessages = Array.isArray(parsed.messages) ? parsed.messages.slice(0, 20).filter((message: any) => message && (message.type === "text" || message.type === "media")) : [];
    const imageLimit = await maxImagesPerResponse(row.tenant_id);
    let mediaCount = 0;
    const messages = rawMessages.filter((message: any) => message.type !== "media" || mediaCount++ < imageLimit).slice(0, 10);
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
    if (!messages.length && !parsed.handoff) messages.push({ type: "text", text: "I’m unable to answer that right now. A team member can help if needed." });
    await query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,provider,model,task_key,correlation_id,idempotency_key,metadata)
      VALUES ($1,$2,$3,$4,'ai_call',1,'call',$5,$6,'DEFAULT_CHAT',$7,$8,$9::jsonb) ON CONFLICT DO NOTHING`, [row.tenant_id, row.business_id, row.channel_account_id, row.conversation_id, model.provider, model.model, requestId(request), `ai:${input.turnId}:${row.active_prompt_version_id}`, JSON.stringify(result.usage)]);
    for (const [index, extra] of multimodal.usage.entries()) {
      await query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,provider,model,task_key,correlation_id,idempotency_key,metadata)
        VALUES ($1,$2,$3,$4,'ai_call',1,'call',$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT DO NOTHING`,
        [row.tenant_id,row.business_id,row.channel_account_id,row.conversation_id,(extra as any).provider,(extra as any).model,(extra as any).task,requestId(request),`ai-extra:${input.turnId}:${index}:${(extra as any).task}`,JSON.stringify((extra as any).usage ?? {})]);
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
      tool: z.enum(["create_order", "create_booking", "create_lead", "handoff_conversation"]),
      arguments: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().min(1).max(300),
    }).parse(request.body);
    const conversation = await query<any>("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND channel_account_id=$4", [input.conversationId, input.tenantId, input.businessId, input.channelAccountId]);
    if (!conversation.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    const agent = conversation.rows[0].agent_profile_id ? await query<{ capabilities: string[] }>("SELECT capabilities FROM agent_profiles WHERE id=$1", [conversation.rows[0].agent_profile_id]) : { rows: [] } as any;
    const capabilityMap: Record<string, string> = { create_order: "ORDER_CREATE", create_booking: "BOOKING_CREATE", create_lead: "LEAD_CAPTURE", handoff_conversation: "HUMAN_HANDOFF" };
    if (!agent.rows[0]?.capabilities?.includes(capabilityMap[input.tool])) throw new ApiError(403, "CAPABILITY_DISABLED", `Capability ${capabilityMap[input.tool]} is not enabled.`);
    const existing = await query<{ response_json: any; status: string }>("SELECT response_json,status FROM idempotency_keys WHERE tenant_id=$1 AND scope='agent_action' AND key=$2", [input.tenantId, input.idempotencyKey]);
    if (existing.rows[0]?.status === "completed") return reply.send(existing.rows[0].response_json);
    if (input.tool === "handoff_conversation") {
      const updated = await query("UPDATE conversations SET mode='HUMAN',state_version=state_version+1,escalation_metadata=escalation_metadata||$2::jsonb,updated_at=now() WHERE id=$1 RETURNING *", [input.conversationId, JSON.stringify({ aiHandoffReason: input.arguments.reason ?? null })]);
      const response = { tool: input.tool, conversation: updated.rows[0] };
      await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status,response_json) VALUES ($1,'agent_action',$2,'completed',$3::jsonb) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='completed',response_json=EXCLUDED.response_json,updated_at=now()`, [input.tenantId, input.idempotencyKey, JSON.stringify(response)]);
      return reply.send(response);
    }
    const endpoint = input.tool === "create_order" ? "orders" : input.tool === "create_booking" ? "bookings" : "leads";
    const response = await fetch(`${env().API_PUBLIC_ORIGIN}/v1/tenants/${input.tenantId}/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${env().INTERNAL_SERVICE_AUTH_SECRET}`, "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ ...input.arguments, businessId: input.businessId, channelAccountId: input.channelAccountId, conversationId: input.conversationId, contactId: conversation.rows[0].contact_id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(response.status, "ACTION_EXECUTION_FAILED", `Action ${input.tool} failed.`, body);
    await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status,response_json) VALUES ($1,'agent_action',$2,'completed',$3::jsonb) ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='completed',response_json=EXCLUDED.response_json,updated_at=now()`, [input.tenantId, input.idempotencyKey, JSON.stringify(body)]);
    reply.send({ tool: input.tool, result: body });
  });

  app.post("/v1/internal/outbound/enqueue", async (request, reply) => {
    requireInternal(request);
    const input = z.object({
      tenantId: z.string().uuid(),
      businessId: z.string().uuid(),
      channelAccountId: z.string().uuid(),
      conversationId: z.string().uuid(),
      stateVersion: z.number().int().positive().optional(),
      messages: z.array(z.union([z.object({ type: z.literal("text"), text: z.string().min(1).max(20000) }), z.object({ type: z.literal("media"), assetId: z.string().uuid(), caption: z.string().max(2000).nullable().optional() })])).min(1).max(10),
      priority: z.enum(["HUMAN", "TRANSACTIONAL", "CUSTOMER_ACTIVE", "NORMAL", "FOLLOWUP"]).default("CUSTOMER_ACTIVE"),
      senderType: z.enum(["AI", "HUMAN", "SYSTEM"]).default("AI"),
      logicalResponseId: z.string().min(1).max(200).optional(),
    }).parse(request.body);
    const cv = await query<any>("SELECT mode,state_version FROM conversations WHERE id=$1 AND tenant_id=$2 AND channel_account_id=$3", [input.conversationId, input.tenantId, input.channelAccountId]);
    if (!cv.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    if (input.senderType === "AI" && cv.rows[0].mode !== "AI") throw new ApiError(409, "AI_SUPPRESSED_BY_MODE", "AI delivery is blocked because the conversation is not in AI mode.");
    if (input.stateVersion && Number(cv.rows[0].state_version) !== input.stateVersion) throw new ApiError(409, "CONVERSATION_VERSION_CHANGED", "Conversation state changed while the response was being generated.");
    const logicalResponseId = input.logicalResponseId ?? randomToken(18);
    let i = 0;
    for (const message of input.messages) {
      const jobId = `outbound:${logicalResponseId}:${i++}`;
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
        payload: { logicalResponseId, priority: input.priority, senderType: input.senderType, message },
      });
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
