import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue, query, QUEUES, randomToken, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, requestId } from "../lib.js";

export async function conversationRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/conversations", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({
      businessId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
      mode: z.enum(["AI", "HUMAN", "PAUSED"]).optional(),
      status: z.enum(["open", "closed", "archived"]).default("open"),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const result = await query(`
      SELECT cv.*,ct.external_contact_id,ct.display_name,ca.platform,ca.name AS channel_name,b.name AS business_name,
        (SELECT m.text_content FROM messages m WHERE m.conversation_id=cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_text,
        (SELECT m.sender_type FROM messages m WHERE m.conversation_id=cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_sender_type
      FROM conversations cv
      JOIN contacts ct ON ct.id=cv.contact_id
      JOIN channel_accounts ca ON ca.id=cv.channel_account_id
      JOIN businesses b ON b.id=cv.business_id
      WHERE cv.tenant_id=$1 AND cv.status=$2
        AND ($3::uuid IS NULL OR cv.business_id=$3)
        AND ($4::uuid IS NULL OR cv.channel_account_id=$4)
        AND ($5::text IS NULL OR cv.mode=$5)
        AND ($6::uuid[] IS NULL OR cv.business_id=ANY($6::uuid[]))
      ORDER BY cv.last_message_at DESC NULLS LAST LIMIT $7 OFFSET $8
    `, [tenantId, q.status, q.businessId ?? null, q.channelId ?? null, q.mode ?? null, scope, q.limit, q.offset]);
    reply.send({ conversations: result.rows, limit: q.limit, offset: q.offset });
  });

  app.get("/v1/tenants/:tenantId/conversations/:conversationId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const conversation = await query(`
      SELECT cv.*,ct.external_contact_id,ct.display_name,ct.phone,ct.email,ca.platform,ca.name AS channel_name,b.name AS business_name,a.name AS agent_name
      FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id JOIN channel_accounts ca ON ca.id=cv.channel_account_id
      JOIN businesses b ON b.id=cv.business_id LEFT JOIN agent_profiles a ON a.id=cv.agent_profile_id
      WHERE cv.id=$1 AND cv.tenant_id=$2
    `, [params.conversationId, params.tenantId]);
    if (!conversation.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    await requireBusinessAccess(request, params.tenantId, conversation.rows[0].business_id);
    const messages = await query(`
      SELECT m.*,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',ma.id,'mimeType',ma.mime_type,'kind',ma.kind,'publicUrl',ma.public_url,'originalName',ma.original_name) ORDER BY mm.display_order)
                  FROM message_media mm JOIN media_assets ma ON ma.id=mm.media_asset_id WHERE mm.message_id=m.id),'[]'::jsonb) AS media
      FROM messages m WHERE m.conversation_id=$1 ORDER BY m.created_at ASC LIMIT 500
    `, [params.conversationId]);
    const related = await Promise.all([
      query("SELECT * FROM orders WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20", [params.conversationId]),
      query("SELECT * FROM bookings WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20", [params.conversationId]),
      query("SELECT * FROM leads WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 20", [params.conversationId]),
    ]);
    reply.send({ conversation: conversation.rows[0], messages: messages.rows, orders: related[0].rows, bookings: related[1].rows, leads: related[2].rows });
  });

  app.post("/v1/tenants/:tenantId/conversations/:conversationId/mode", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const scopeConversation = await query<{ business_id: string }>("SELECT business_id FROM conversations WHERE id=$1 AND tenant_id=$2", [params.conversationId,params.tenantId]);
    if (!scopeConversation.rows[0]) throw new ApiError(404,"CONVERSATION_NOT_FOUND","Conversation not found.");
    await requireBusinessAccess(request, params.tenantId, scopeConversation.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input = z.object({ mode: z.enum(["AI", "HUMAN", "PAUSED"]), reason: z.string().max(500).optional() }).parse(request.body);
    const result = await query(`
      UPDATE conversations SET mode=$3,state_version=state_version+1,
        escalation_metadata=escalation_metadata || $4::jsonb,updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *
    `, [params.conversationId, params.tenantId, input.mode, JSON.stringify({ lastModeReason: input.reason ?? null, lastModeChangedBy: principal.userId, lastModeChangedAt: new Date().toISOString() })]);
    if (!result.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: result.rows[0].business_id, action: "CONVERSATION_MODE_CHANGED", resourceType: "conversation", resourceId: params.conversationId, safeDiff: input, request });
    reply.send({ conversation: result.rows[0] });
  });

  app.post("/v1/tenants/:tenantId/conversations/:conversationId/reply", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({ text: z.string().max(20000).optional(), assetIds: z.array(z.string().uuid()).max(10).default([]) }).parse(request.body);
    if (!input.text?.trim() && !input.assetIds.length) throw new ApiError(400, "EMPTY_REPLY", "Reply must contain text or media.");
    const conversation = await query<any>("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2", [params.conversationId, params.tenantId]);
    if (!conversation.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    const cv = conversation.rows[0];
    await requireBusinessAccess(request, params.tenantId, cv.business_id, ["OWNER","ADMIN","STAFF"]);
    const messages: Array<Record<string, unknown>> = [];
    if (input.text?.trim()) messages.push({ type: "text", text: input.text.trim() });
    for (const assetId of input.assetIds) {
      const asset = await query("SELECT id FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status='ready'", [assetId, params.tenantId]);
      if (!asset.rows[0]) throw new ApiError(404, "MEDIA_NOT_FOUND", `Media asset ${assetId} not found.`);
      messages.push({ type: "media", assetId });
    }
    const logicalResponseId = randomToken(18);
    await transaction(async (client) => {
      await client.query("UPDATE conversations SET mode='HUMAN',assigned_user_id=$2,state_version=state_version+1,updated_at=now() WHERE id=$1", [params.conversationId, principal.userId]);
      await client.query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,correlation_id,payload)
        VALUES ($1,'HUMAN_REPLY_ENQUEUED',$2,'conversation',$3,$4,$5::jsonb)`, [params.tenantId, cv.business_id, params.conversationId, requestId(request), JSON.stringify({ logicalResponseId, messages })]);
    });
    let index = 0;
    for (const message of messages) {
      const jobId = `outbound:${logicalResponseId}:${index++}`;
      await enqueue(QUEUES.outbound, {
        jobId,
        jobType: "SEND_MESSAGE",
        tenantId: params.tenantId,
        businessId: cv.business_id,
        channelAccountId: cv.channel_account_id,
        conversationId: params.conversationId,
        correlationId: requestId(request),
        idempotencyKey: jobId,
        createdAt: new Date().toISOString(),
        payload: { logicalResponseId, priority: "HUMAN", senderType: "HUMAN", actorUserId: principal.userId, message },
      });
    }
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: cv.business_id, action: "HUMAN_REPLY_QUEUED", resourceType: "conversation", resourceId: params.conversationId, safeDiff: { text: Boolean(input.text), mediaCount: input.assetIds.length }, request });
    reply.code(202).send({ ok: true, logicalResponseId });
  });

  app.get("/v1/tenants/:tenantId/conversations/:conversationId/followups", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    const cvScope = await query<{ business_id: string }>("SELECT business_id FROM conversations WHERE id=$1 AND tenant_id=$2", [params.conversationId,params.tenantId]);
    if (!cvScope.rows[0]) throw new ApiError(404,"CONVERSATION_NOT_FOUND","Conversation not found.");
    await requireBusinessAccess(request, params.tenantId, cvScope.rows[0].business_id);
    const result = await query("SELECT * FROM followup_jobs WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY due_at DESC LIMIT 100", [params.tenantId,params.conversationId]);
    reply.send({ followups: result.rows });
  });

  app.post("/v1/tenants/:tenantId/conversations/:conversationId/followups", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input = z.object({
      delayMinutes: z.number().int().min(1).max(60 * 24 * 30),
      message: z.string().trim().min(1).max(5000),
      maxWindowHours: z.number().min(1).max(72).default(23),
    }).parse(request.body);
    const cv = await query<any>("SELECT * FROM conversations WHERE id=$1 AND tenant_id=$2 AND status='open'", [params.conversationId,params.tenantId]);
    if (!cv.rows[0]) throw new ApiError(404,"CONVERSATION_NOT_FOUND","Conversation not found.");
    await requireBusinessAccess(request, params.tenantId, cv.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const idempotencyKey = `manual-followup:${params.conversationId}:${Date.now()}:${randomToken(6)}`;
    const row = await query<any>(`
      INSERT INTO followup_jobs(tenant_id,business_id,channel_account_id,conversation_id,agent_profile_id,due_at,policy_snapshot,idempotency_key)
      VALUES ($1,$2,$3,$4,$5,now()+($6 || ' minutes')::interval,$7::jsonb,$8)
      RETURNING *
    `, [params.tenantId,cv.rows[0].business_id,cv.rows[0].channel_account_id,params.conversationId,cv.rows[0].agent_profile_id ?? null,String(input.delayMinutes),JSON.stringify({message:input.message,maxWindowHours:input.maxWindowHours,createdBy:principal.userId}),idempotencyKey]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: cv.rows[0].business_id, action: "FOLLOWUP_SCHEDULED", resourceType: "followup_job", resourceId: row.rows[0].id, safeDiff: { delayMinutes: input.delayMinutes }, request });
    reply.code(201).send({ followup: row.rows[0] });
  });

  app.delete("/v1/tenants/:tenantId/conversations/:conversationId/followups/:followupId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid(), followupId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const row = await query<any>("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE id=$1 AND tenant_id=$2 AND conversation_id=$3 AND status IN ('scheduled','queued') RETURNING business_id", [params.followupId,params.tenantId,params.conversationId]);
    if (!row.rows[0]) throw new ApiError(404,"FOLLOWUP_NOT_FOUND","Active follow-up not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: row.rows[0].business_id, action: "FOLLOWUP_CANCELLED", resourceType: "followup_job", resourceId: params.followupId, request });
    reply.send({ ok: true });
  });

  app.post("/v1/tenants/:tenantId/conversations/:conversationId/close", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), conversationId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const closeScope = await query<{ business_id: string }>("SELECT business_id FROM conversations WHERE id=$1 AND tenant_id=$2", [params.conversationId,params.tenantId]);
    if (!closeScope.rows[0]) throw new ApiError(404,"CONVERSATION_NOT_FOUND","Conversation not found.");
    await requireBusinessAccess(request, params.tenantId, closeScope.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const result = await query("UPDATE conversations SET status='closed',state_version=state_version+1,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING business_id", [params.conversationId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: result.rows[0].business_id, action: "CONVERSATION_CLOSED", resourceType: "conversation", resourceId: params.conversationId, request });
    reply.send({ ok: true });
  });
}
