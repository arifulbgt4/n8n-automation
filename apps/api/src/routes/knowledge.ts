import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue, query, QUEUES } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, requestId } from "../lib.js";

export async function knowledgeRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/knowledge", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional(), agentId: z.string().uuid().optional(), status: z.string().max(40).optional() }).parse(request.query);
    const result = await query(`
      SELECT ks.*,
        (SELECT count(*)::int FROM knowledge_chunks kc WHERE kc.source_id=ks.id AND kc.active=true) AS chunk_count
      FROM knowledge_sources ks
      WHERE ks.tenant_id=$1
        AND ($2::uuid IS NULL OR ks.business_id=$2)
        AND ($3::uuid IS NULL OR ks.agent_profile_id=$3)
        AND ($4::text IS NULL OR ks.status=$4)
        AND ($5::uuid[] IS NULL OR ks.business_id=ANY($5::uuid[]))
      ORDER BY ks.updated_at DESC
    `, [tenantId, q.businessId ?? null, q.agentId ?? null, q.status ?? null, scope]);
    reply.send({ sources: result.rows });
  });

  app.post("/v1/tenants/:tenantId/knowledge", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid(),
      agentProfileId: z.string().uuid().nullable().optional(),
      type: z.enum(["faq", "policy", "document", "collection_description", "approved_answer", "custom"]),
      title: z.string().trim().min(1).max(240),
      content: z.string().min(1).max(2_000_000),
      mediaAssetId: z.string().uuid().nullable().optional(),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    await requireBusinessAccess(request, tenantId, input.businessId, ["OWNER","ADMIN","STAFF"]);
    const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [input.businessId, tenantId]);
    if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    if (input.agentProfileId) {
      const agent = await query("SELECT id FROM agent_profiles WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [input.agentProfileId, tenantId, input.businessId]);
      if (!agent.rows[0]) throw new ApiError(400, "AGENT_SCOPE_INVALID", "Agent does not belong to this business.");
    }
    const result = await query(`
      INSERT INTO knowledge_sources(tenant_id,business_id,agent_profile_id,type,title,content,media_asset_id,status,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb) RETURNING *
    `, [tenantId, input.businessId, input.agentProfileId ?? null, input.type, input.title, input.content, input.mediaAssetId ?? null, JSON.stringify(input.metadata)]);
    const source = result.rows[0];
    await enqueue(QUEUES.embeddings, {
      jobId: `embedding:${source.id}:${source.source_version}`,
      jobType: "INDEX_KNOWLEDGE",
      tenantId,
      businessId: input.businessId,
      correlationId: requestId(request),
      idempotencyKey: `embedding:${source.id}:${source.source_version}`,
      createdAt: new Date().toISOString(),
      payload: { sourceId: source.id, sourceVersion: source.source_version },
    });
    await audit({ actorUserId: principal.userId, tenantId, businessId: input.businessId, action: "KNOWLEDGE_SOURCE_CREATED", resourceType: "knowledge_source", resourceId: source.id, safeDiff: { type: input.type, title: input.title }, request });
    reply.code(201).send({ source });
  });

  app.patch("/v1/tenants/:tenantId/knowledge/:sourceId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), sourceId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({ title: z.string().trim().min(1).max(240).optional(), content: z.string().min(1).max(2_000_000).optional(), status: z.enum(["pending", "indexing", "ready", "error", "archived"]).optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const current = await query<any>("SELECT * FROM knowledge_sources WHERE id=$1 AND tenant_id=$2", [params.sourceId, params.tenantId]);
    if (!current.rows[0]) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Knowledge source not found.");
    await requireBusinessAccess(request, params.tenantId, current.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const contentChanged = input.content !== undefined && input.content !== current.rows[0].content;
    const result = await query(`
      UPDATE knowledge_sources SET title=COALESCE($3,title),content=COALESCE($4,content),status=CASE WHEN $5::boolean THEN 'pending' ELSE COALESCE($6,status) END,
        source_version=source_version + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
        metadata=CASE WHEN $7::jsonb IS NULL THEN metadata ELSE metadata||$7::jsonb END,updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *
    `, [params.sourceId, params.tenantId, input.title ?? null, input.content ?? null, contentChanged, input.status ?? null, input.metadata ? JSON.stringify(input.metadata) : null]);
    const source = result.rows[0];
    if (contentChanged) {
      await enqueue(QUEUES.embeddings, {
        jobId: `embedding:${source.id}:${source.source_version}`,
        jobType: "INDEX_KNOWLEDGE",
        tenantId: params.tenantId,
        businessId: source.business_id,
        correlationId: requestId(request),
        idempotencyKey: `embedding:${source.id}:${source.source_version}`,
        createdAt: new Date().toISOString(),
        payload: { sourceId: source.id, sourceVersion: source.source_version },
      });
    }
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: source.business_id, action: "KNOWLEDGE_SOURCE_UPDATED", resourceType: "knowledge_source", resourceId: params.sourceId, safeDiff: { title: input.title, contentChanged, status: input.status }, request });
    reply.send({ source });
  });

  app.delete("/v1/tenants/:tenantId/knowledge/:sourceId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), sourceId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const result = await query("UPDATE knowledge_sources SET status='archived',updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING business_id", [params.sourceId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Knowledge source not found.");
    await query("UPDATE knowledge_chunks SET active=false WHERE source_id=$1", [params.sourceId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: result.rows[0].business_id, action: "KNOWLEDGE_SOURCE_ARCHIVED", resourceType: "knowledge_source", resourceId: params.sourceId, request });
    reply.send({ ok: true });
  });
}
