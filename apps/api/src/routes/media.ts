import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  env,
  mediaApiKeyForAsset,
  query,
  sha256,
  sharedMediaApiKey,
} from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";
import { assertMediaStorageLimit, customerMediaStorageLimit } from "../limits.js";

function mediaBase(): string {
  const base = env().MEDIA_BASE_URL;
  if (!base) throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Media storage service is not configured.");
  return base.replace(/\/$/, "");
}

function sharedCredential(): string {
  try { return sharedMediaApiKey(); }
  catch { throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Shared Media Storage is not configured."); }
}

async function mediaFetch(path: string, apiKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetch(`${mediaBase()}${path}`, { ...init, headers });
  return response;
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/media/storage", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    if (context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(403, "TENANT_SCOPE_REQUIRED", "A restricted administrator cannot inspect tenant-wide media storage.");
    }
    if (!env().MEDIA_API_KEY) throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Shared Media Storage is not configured.");
    const quotaBytes = await customerMediaStorageLimit(tenantId);
    const used = await query<{ used: string }>("SELECT COALESCE(sum(size_bytes),0)::text AS used FROM media_assets WHERE tenant_id=$1 AND processing_status<>'deleted'", [tenantId]);
    const usedBytes = Number(used.rows[0]?.used ?? 0);
    reply.send({ storage: { used_bytes: usedBytes, quota_bytes: quotaBytes, available_bytes: Math.max(0, quotaBytes - usedBytes) } });
  });

  app.get("/v1/tenants/:tenantId/media", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0), businessId: z.string().uuid().optional() }).parse(request.query);
    const result = await query(`
      SELECT m.*,
        (SELECT count(*)::int FROM collection_item_media cim WHERE cim.media_asset_id=m.id) +
        (SELECT count(*)::int FROM message_media mm WHERE mm.media_asset_id=m.id) AS reference_count
      FROM media_assets m
      WHERE m.tenant_id=$1 AND m.processing_status<>'deleted'
        AND COALESCE(m.metadata->>'source','') NOT IN ('tenant_export','collection_export')
        AND ($2::uuid IS NULL OR m.business_id=$2)
        AND ($3::uuid[] IS NULL OR m.business_id IS NULL OR m.business_id=ANY($3::uuid[]))
      ORDER BY m.created_at DESC LIMIT $4 OFFSET $5
    `, [tenantId, q.businessId ?? null, scope, q.limit, q.offset]);
    const count = await query<{ count: string }>(`
      SELECT count(*)
      FROM media_assets m
      WHERE m.tenant_id=$1 AND m.processing_status<>'deleted'
        AND COALESCE(m.metadata->>'source','') NOT IN ('tenant_export','collection_export')
        AND ($2::uuid IS NULL OR m.business_id=$2)
        AND ($3::uuid[] IS NULL OR m.business_id IS NULL OR m.business_id=ANY($3::uuid[]))
    `, [tenantId, q.businessId ?? null, scope]);
    reply.send({ assets: result.rows, total: Number(count.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset });
  });

  app.post("/v1/tenants/:tenantId/media", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const businessIdHeader = request.headers["x-business-id"] as string | undefined;
    const businessId = businessIdHeader ? z.string().uuid().parse(businessIdHeader) : null;
    if (context.membershipRole !== "OWNER" && !businessId) {
      throw new ApiError(403, "BUSINESS_SCOPE_REQUIRED", "A non-owner media upload must target a selected business.");
    }
    if (businessId) {
      await requireBusinessAccess(request, tenantId, businessId, ["OWNER","ADMIN","STAFF"]);
      const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [businessId, tenantId]);
      if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    }
    let file: any;
    try {
      file = await request.file({ limits: { fileSize: env().MAX_UPLOAD_BYTES, files: 1 } });
    } catch {
      throw new ApiError(413, "MEDIA_FILE_TOO_LARGE", "The uploaded file exceeds the allowed request size.", { limitBytes: env().MAX_UPLOAD_BYTES });
    }
    if (!file) throw new ApiError(400, "FILE_REQUIRED", "A file is required.");
    const visibilityField = file.fields.visibility;
    const visibility = visibilityField && "value" in visibilityField && visibilityField.value === "public" ? "public" : "private";
    if (visibility === "public" && context.membershipRole !== "OWNER" && context.membershipRole !== "ADMIN") {
      throw new ApiError(403, "PUBLIC_MEDIA_FORBIDDEN", "Only an owner or administrator can publish media publicly.");
    }
    const bytes = await file.toBuffer();
    await assertMediaStorageLimit(tenantId, bytes.length);
    const form = new FormData();
    const uploadBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.set("file", new Blob([uploadBuffer], { type: file.mimetype }), file.filename);
    form.set("visibility", visibility);
    const response = await mediaFetch("/api/v1/files", sharedCredential(), { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new ApiError(response.status >= 500 ? 502 : 400, "MEDIA_UPLOAD_FAILED", body.message || "Media upload failed.", body);
    const storageFile = body.file ?? body;
    if (!storageFile.id || !storageFile.mime_type || !storageFile.user_id) {
      if (storageFile.id) await mediaFetch(`/api/v1/files/${encodeURIComponent(storageFile.id)}`, sharedCredential(), { method: "DELETE" }).catch(() => undefined);
      throw new ApiError(502, "MEDIA_RESPONSE_INVALID", "Media storage returned an invalid response.");
    }

    let asset: any;
    try {
      const checksum = storageFile.checksum_sha256 ?? sha256(bytes);
      const duplicate = await query<any>(`
        SELECT * FROM media_assets
        WHERE tenant_id=$1 AND content_hash=$2 AND processing_status='ready'
          AND (($3::uuid IS NULL AND business_id IS NULL) OR business_id=$3)
        ORDER BY created_at LIMIT 1
      `, [tenantId, checksum, businessId]);
      if (duplicate.rows[0]) {
        await mediaFetch(`/api/v1/files/${encodeURIComponent(storageFile.id)}`, sharedCredential(), { method: "DELETE" }).catch(() => undefined);
        return reply.status(200).send({ asset: duplicate.rows[0], deduplicated: true });
      }
      asset = await query(`
        INSERT INTO media_assets(tenant_id,business_id,storage_file_id,storage_user_id,original_name,mime_type,kind,size_bytes,visibility,content_hash,public_url,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
        ON CONFLICT(tenant_id,storage_file_id) DO UPDATE SET updated_at=now()
        RETURNING *
      `, [tenantId, businessId, storageFile.id, storageFile.user_id, storageFile.original_name ?? file.filename, storageFile.mime_type, storageFile.kind ?? null, storageFile.size_bytes ?? bytes.length, storageFile.visibility ?? visibility, storageFile.checksum_sha256 ?? sha256(bytes), storageFile.public_url ?? null, JSON.stringify({ contentUrl: storageFile.content_url ?? `/api/v1/files/${storageFile.id}/content` })]);
    } catch (error) {
      await mediaFetch(`/api/v1/files/${encodeURIComponent(storageFile.id)}`, sharedCredential(), { method: "DELETE" }).catch(() => undefined);
      if ((error as { code?: string }).code === "23514") {
        throw new ApiError(402, "MEDIA_STORAGE_LIMIT_REACHED", "Workspace media storage limit reached.");
      }
      throw error;
    }
    await audit({ actorUserId: principal.userId, tenantId, businessId, action: "MEDIA_UPLOADED", resourceType: "media_asset", resourceId: asset.rows[0].id, safeDiff: { originalName: file.filename, sizeBytes: bytes.length, visibility }, request });
    reply.code(201).send({ asset: asset.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/media/:assetId/content", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, params.tenantId);
    const asset = await query<{ storage_file_id: string; storage_user_id: string | null; mime_type: string; original_name: string | null; business_id: string | null; metadata: Record<string, unknown> | null }>("SELECT storage_file_id,storage_user_id,mime_type,original_name,business_id,metadata FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status<>'deleted'", [params.assetId, params.tenantId]);
    if (!asset.rows[0]) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    if (String(asset.rows[0].metadata?.source ?? "") === "tenant_export" && context.membershipRole !== "OWNER") {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (asset.rows[0].business_id) await requireBusinessAccess(request, params.tenantId, asset.rows[0].business_id);
    const response = await mediaFetch(`/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}/content`, await mediaApiKeyForAsset(params.tenantId, asset.rows[0].storage_user_id));
    if (!response.ok || !response.body) throw new ApiError(502, "MEDIA_DOWNLOAD_FAILED", "Unable to download media content.");
    reply.header("content-type", response.headers.get("content-type") || asset.rows[0].mime_type);
    reply.header("cache-control", "private, no-store");
    if (asset.rows[0].original_name) reply.header("content-disposition", `inline; filename="${asset.rows[0].original_name.replace(/[\r\n\"]/g, "_")}"`);
    return reply.send(response.body);
  });

  app.get("/v1/tenants/:tenantId/data-requests/:requestId/download", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), requestId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId, ["OWNER"]);
    const result = await query<{ storage_file_id: string; storage_user_id: string | null; mime_type: string; original_name: string | null; metadata: Record<string, unknown> | null }>(`
      SELECT m.storage_file_id,m.storage_user_id,m.mime_type,m.original_name,m.metadata
      FROM tenant_data_requests r
      JOIN media_assets m ON m.id=r.result_media_asset_id
      WHERE r.id=$1 AND r.tenant_id=$2 AND r.type='export' AND r.status='completed' AND m.processing_status<>'deleted'
    `, [params.requestId, params.tenantId]);
    const asset = result.rows[0];
    if (!asset || !["tenant_export", "collection_export"].includes(String(asset.metadata?.source ?? ""))) {
      throw new ApiError(404, "EXPORT_NOT_FOUND", "Completed export is not available.");
    }
    const response = await mediaFetch(`/api/v1/files/${encodeURIComponent(asset.storage_file_id)}/content`, await mediaApiKeyForAsset(params.tenantId, asset.storage_user_id));
    if (!response.ok || !response.body) throw new ApiError(502, "MEDIA_DOWNLOAD_FAILED", "Unable to download the export.");
    reply.header("content-type", response.headers.get("content-type") || asset.mime_type || "application/json");
    reply.header("cache-control", "private, no-store");
    reply.header("content-disposition", `attachment; filename="${(asset.original_name || "tenant-export.json").replace(/[\r\n\"]/g, "_")}"`);
    return reply.send(response.body);
  });

  app.delete("/v1/tenants/:tenantId/media/:assetId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    requireCsrf(request);
    const context = await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    const asset = await query<{ storage_file_id: string; storage_user_id: string | null; business_id: string | null; metadata: Record<string, unknown> | null }>(`
      SELECT m.storage_file_id,m.storage_user_id,m.business_id,m.metadata
      FROM media_assets m
      WHERE m.id=$1 AND m.tenant_id=$2 AND m.processing_status<>'deleted'
        AND NOT EXISTS(SELECT 1 FROM collection_item_media x WHERE x.media_asset_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM message_media x WHERE x.media_asset_id=m.id)
    `, [params.assetId, params.tenantId]);
    if (!asset.rows[0]) throw new ApiError(409, "MEDIA_IN_USE_OR_MISSING", "Media is referenced by another record or does not exist.");
    if (String(asset.rows[0].metadata?.source ?? "") === "tenant_export" && context.membershipRole !== "OWNER") {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (!asset.rows[0].business_id && context.membershipRole === "STAFF") {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (!asset.rows[0].business_id && context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (asset.rows[0].business_id) await requireBusinessAccess(request, params.tenantId, asset.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const response = await mediaFetch(`/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}`, await mediaApiKeyForAsset(params.tenantId, asset.rows[0].storage_user_id), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new ApiError(502, "MEDIA_DELETE_FAILED", "Media storage deletion failed.");
    await query("UPDATE media_assets SET processing_status='deleted',updated_at=now() WHERE id=$1", [params.assetId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: asset.rows[0].business_id, action: "MEDIA_DELETED", resourceType: "media_asset", resourceId: params.assetId, request });
    reply.send({ ok: true });
  });

  app.patch("/v1/tenants/:tenantId/media/:assetId/visibility", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),assetId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    const context=await requireTenant(request,params.tenantId,["OWNER","ADMIN"]);
    requireCsrf(request);
    const input=z.object({visibility:z.enum(["private","public"])}).parse(request.body);
    const asset=await query<any>("SELECT * FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status<>'deleted'",[params.assetId,params.tenantId]);
    if(!asset.rows[0]) throw new ApiError(404,"MEDIA_NOT_FOUND","Media asset not found.");
    if (String(asset.rows[0].metadata?.source ?? "") === "tenant_export" && context.membershipRole !== "OWNER") {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (!asset.rows[0].business_id && context.membershipRole !== "OWNER" && Array.isArray(context.businessScope)) {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if(asset.rows[0].business_id) await requireBusinessAccess(request,params.tenantId,asset.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
    const response=await mediaFetch(`/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}`,await mediaApiKeyForAsset(params.tenantId,asset.rows[0].storage_user_id),{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({visibility:input.visibility})});
    const body=await response.json().catch(()=>({})) as any;
    if(!response.ok) throw new ApiError(502,"MEDIA_VISIBILITY_FAILED",body?.message || "Media visibility update failed.",body);
    const file=body.file ?? body;
    const updated=await query<any>("UPDATE media_assets SET visibility=$2,public_url=$3,updated_at=now() WHERE id=$1 RETURNING *",[params.assetId,input.visibility,file.public_url ?? null]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:asset.rows[0].business_id,action:"MEDIA_VISIBILITY_UPDATED",resourceType:"media_asset",resourceId:params.assetId,safeDiff:input,request});
    reply.send({asset:updated.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId/media", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({ assetId: z.string().uuid(), role: z.string().max(40).default("gallery"), displayOrder: z.number().int().min(0).default(0) }).parse(request.body);
    const scope = await query<{ business_id: string; collection_business_id: string }>(`
      SELECT i.business_id,c.business_id AS collection_business_id FROM collection_items i JOIN collections c ON c.id=i.collection_id
      WHERE i.id=$1 AND i.collection_id=$2 AND i.tenant_id=$3
    `, [params.itemId, params.collectionId, params.tenantId]);
    if (!scope.rows[0] || scope.rows[0].business_id !== scope.rows[0].collection_business_id) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found.");
    await requireBusinessAccess(request, params.tenantId, scope.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const asset = await query<{ id: string; business_id: string | null; metadata: Record<string, unknown> | null }>(
      "SELECT id,business_id,metadata FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status='ready'",
      [input.assetId, params.tenantId],
    );
    if (!asset.rows[0]) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    if (["tenant_export", "collection_export"].includes(String(asset.rows[0].metadata?.source ?? ""))) {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    if (asset.rows[0].business_id && asset.rows[0].business_id !== scope.rows[0].business_id) {
      throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    }
    await query(`
      INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id,role,display_order)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(collection_item_id,media_asset_id) DO UPDATE SET role=EXCLUDED.role,display_order=EXCLUDED.display_order
    `, [params.itemId, input.assetId, params.tenantId, input.role, input.displayOrder]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: scope.rows[0].business_id, action: "ITEM_MEDIA_LINKED", resourceType: "collection_item", resourceId: params.itemId, safeDiff: input, request });
    reply.send({ ok: true });
  });
}
