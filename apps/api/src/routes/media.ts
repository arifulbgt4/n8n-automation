import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  env,
  maskSecret,
  query,
  sha256,
  transaction,
} from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";
import { assertMediaStorageLimit, tenantLimit } from "../limits.js";

async function mediaAccount(tenantId: string) {
  const result = await query<{
    id: string;
    external_media_user_id: string | null;
    encrypted_api_key: string | null;
    status: string;
  }>("SELECT id,external_media_user_id,encrypted_api_key,status FROM tenant_media_accounts WHERE tenant_id=$1", [tenantId]);
  return result.rows[0] ?? null;
}

async function resolveMediaCredential(tenantId: string): Promise<string> {
  const account = await mediaAccount(tenantId);
  if (account?.encrypted_api_key) return decryptSecret(account.encrypted_api_key);
  const mediaApiKey = env().MEDIA_API_KEY;
  if (mediaApiKey) return mediaApiKey;
  throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Media storage is not configured for this tenant.");
}

function mediaBase(): string {
  const base = env().MEDIA_BASE_URL;
  if (!base) throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Media storage service is not configured.");
  return base.replace(/\/$/, "");
}

async function mediaFetch(tenantId: string, path: string, init: RequestInit = {}) {
  const apiKey = await resolveMediaCredential(tenantId);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  const response = await fetch(`${mediaBase()}${path}`, { ...init, headers });
  return response;
}

async function provisionTenantMediaUser(tenantId: string, name: string) {
  if (!env().MEDIA_ADMIN_TOKEN) return null;
  const quotaBytes = await tenantLimit(tenantId, "mediaStorageBytes").catch(() => null);
  const response = await fetch(`${mediaBase()}/api/v1/admin/users`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env().MEDIA_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: `tenant-${tenantId}-${name}`.slice(0, 80), quota_bytes: quotaBytes }),
  });
  if (!response.ok) throw new ApiError(502, "MEDIA_PROVISION_FAILED", `Media service user provisioning failed with ${response.status}.`);
  const body = await response.json() as { user?: { id?: string; quota_bytes?: number | null }; api_key?: string };
  if (!body.user?.id || !body.api_key) throw new ApiError(502, "MEDIA_PROVISION_INVALID", "Media service returned an invalid provisioning response.");
  await query(`
    INSERT INTO tenant_media_accounts(tenant_id,external_media_user_id,encrypted_api_key,key_hint,status,quota_bytes,last_health_check_at)
    VALUES ($1,$2,$3,$4,'active',$5,now())
    ON CONFLICT(tenant_id) DO UPDATE SET external_media_user_id=EXCLUDED.external_media_user_id,encrypted_api_key=EXCLUDED.encrypted_api_key,key_hint=EXCLUDED.key_hint,status='active',quota_bytes=EXCLUDED.quota_bytes,updated_at=now()
  `, [tenantId, body.user.id, encryptSecret(body.api_key), maskSecret(body.api_key), body.user.quota_bytes ?? null]);
  return body.user.id;
}

export async function mediaRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/media/storage", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    let account = await mediaAccount(tenantId);
    if (!account && env().MEDIA_ADMIN_TOKEN) {
      const tenant = await query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [tenantId]);
      if (tenant.rows[0]) await provisionTenantMediaUser(tenantId, tenant.rows[0].name);
      account = await mediaAccount(tenantId);
    }
    if (!account && !env().MEDIA_API_KEY) throw new ApiError(503, "MEDIA_NOT_CONFIGURED", "Media storage has not been provisioned.");
    const response = await mediaFetch(tenantId, "/api/v1/storage");
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(502, "MEDIA_STORAGE_ERROR", "Unable to read media storage quota.", body);
    await query("UPDATE tenant_media_accounts SET last_health_check_at=now(),status='active',used_bytes=$2,quota_bytes=$3,updated_at=now() WHERE tenant_id=$1", [tenantId, (body as any).used_bytes ?? null, (body as any).quota_bytes ?? null]).catch(() => undefined);
    reply.send({ storage: body });
  });

  app.post("/v1/tenants/:tenantId/media/provision", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    if (!env().MEDIA_ADMIN_TOKEN) throw new ApiError(503, "MEDIA_AUTO_PROVISION_DISABLED", "Automatic media user provisioning is not configured.");
    const tenant = await query<{ name: string }>("SELECT name FROM tenants WHERE id=$1", [tenantId]);
    if (!tenant.rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
    const userId = await provisionTenantMediaUser(tenantId, tenant.rows[0].name);
    await audit({ actorUserId: principal.userId, tenantId, action: "MEDIA_ACCOUNT_PROVISIONED", resourceType: "tenant_media_account", resourceId: userId, request });
    reply.code(201).send({ ok: true, externalMediaUserId: userId });
  });

  app.post("/v1/tenants/:tenantId/media/attach-credential", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER"]);
    requireCsrf(request);
    const input = z.object({ externalMediaUserId: z.string().min(1), apiKey: z.string().min(10) }).parse(request.body);
    await query(`
      INSERT INTO tenant_media_accounts(tenant_id,external_media_user_id,encrypted_api_key,key_hint,status)
      VALUES ($1,$2,$3,$4,'active')
      ON CONFLICT(tenant_id) DO UPDATE SET external_media_user_id=EXCLUDED.external_media_user_id,encrypted_api_key=EXCLUDED.encrypted_api_key,key_hint=EXCLUDED.key_hint,status='active',updated_at=now()
    `, [tenantId, input.externalMediaUserId, encryptSecret(input.apiKey), maskSecret(input.apiKey)]);
    await audit({ actorUserId: principal.userId, tenantId, action: "MEDIA_CREDENTIAL_ATTACHED", resourceType: "tenant_media_account", safeDiff: { externalMediaUserId: input.externalMediaUserId }, request });
    reply.send({ ok: true });
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
      WHERE m.tenant_id=$1 AND m.processing_status<>'deleted' AND ($2::uuid IS NULL OR m.business_id=$2)
        AND ($3::uuid[] IS NULL OR m.business_id IS NULL OR m.business_id=ANY($3::uuid[]))
      ORDER BY m.created_at DESC LIMIT $4 OFFSET $5
    `, [tenantId, q.businessId ?? null, scope, q.limit, q.offset]);
    const count = await query<{ count: string }>("SELECT count(*) FROM media_assets WHERE tenant_id=$1 AND processing_status<>'deleted'", [tenantId]);
    reply.send({ assets: result.rows, total: Number(count.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset });
  });

  app.post("/v1/tenants/:tenantId/media", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const businessIdHeader = request.headers["x-business-id"] as string | undefined;
    const businessId = businessIdHeader ? z.string().uuid().parse(businessIdHeader) : null;
    if (businessId) {
      await requireBusinessAccess(request, tenantId, businessId, ["OWNER","ADMIN","STAFF"]);
      const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2", [businessId, tenantId]);
      if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    }
    const file = await request.file({ limits: { fileSize: 512 * 1024 * 1024, files: 1 } });
    if (!file) throw new ApiError(400, "FILE_REQUIRED", "A file is required.");
    const visibilityField = file.fields.visibility;
    const visibility = visibilityField && "value" in visibilityField && visibilityField.value === "public" ? "public" : "private";
    const bytes = await file.toBuffer();
    await assertMediaStorageLimit(tenantId, bytes.length);
    const form = new FormData();
    const uploadBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.set("file", new Blob([uploadBuffer], { type: file.mimetype }), file.filename);
    form.set("visibility", visibility);
    const response = await mediaFetch(tenantId, "/api/v1/files", { method: "POST", body: form });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new ApiError(response.status >= 500 ? 502 : 400, "MEDIA_UPLOAD_FAILED", body.message || "Media upload failed.", body);
    const storageFile = body.file ?? body;
    if (!storageFile.id || !storageFile.mime_type) throw new ApiError(502, "MEDIA_RESPONSE_INVALID", "Media storage returned an invalid response.");

    const checksum = storageFile.checksum_sha256 ?? sha256(bytes);
    const duplicate = await query<any>(`
      SELECT * FROM media_assets
      WHERE tenant_id=$1 AND content_hash=$2 AND processing_status='ready'
        AND (($3::uuid IS NULL AND business_id IS NULL) OR business_id=$3)
      ORDER BY created_at LIMIT 1
    `, [tenantId, checksum, businessId]);
    if (duplicate.rows[0]) {
      await mediaFetch(tenantId, `/api/v1/files/${encodeURIComponent(storageFile.id)}`, { method: "DELETE" }).catch(() => undefined);
      return reply.status(200).send({ asset: duplicate.rows[0], deduplicated: true });
    }

    const asset = await query(`
      INSERT INTO media_assets(tenant_id,business_id,storage_file_id,storage_user_id,original_name,mime_type,kind,size_bytes,visibility,content_hash,public_url,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(tenant_id,storage_file_id) DO UPDATE SET updated_at=now()
      RETURNING *
    `, [tenantId, businessId, storageFile.id, storageFile.user_id ?? null, storageFile.original_name ?? file.filename, storageFile.mime_type, storageFile.kind ?? null, storageFile.size_bytes ?? bytes.length, storageFile.visibility ?? visibility, storageFile.checksum_sha256 ?? sha256(bytes), storageFile.public_url ?? null, JSON.stringify({ contentUrl: storageFile.content_url ?? `/api/v1/files/${storageFile.id}/content` })]);
    await audit({ actorUserId: principal.userId, tenantId, businessId, action: "MEDIA_UPLOADED", resourceType: "media_asset", resourceId: asset.rows[0].id, safeDiff: { originalName: file.filename, sizeBytes: bytes.length, visibility }, request });
    reply.code(201).send({ asset: asset.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/media/:assetId/content", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const asset = await query<{ storage_file_id: string; mime_type: string; original_name: string | null; business_id: string | null }>("SELECT storage_file_id,mime_type,original_name,business_id FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status<>'deleted'", [params.assetId, params.tenantId]);
    if (!asset.rows[0]) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    if (asset.rows[0].business_id) await requireBusinessAccess(request, params.tenantId, asset.rows[0].business_id);
    const response = await mediaFetch(params.tenantId, `/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}/content`);
    if (!response.ok || !response.body) throw new ApiError(502, "MEDIA_DOWNLOAD_FAILED", "Unable to download media content.");
    reply.header("content-type", response.headers.get("content-type") || asset.rows[0].mime_type);
    reply.header("cache-control", "private, no-store");
    if (asset.rows[0].original_name) reply.header("content-disposition", `inline; filename="${asset.rows[0].original_name.replace(/[\r\n\"]/g, "_")}"`);
    return reply.send(response.body);
  });

  app.delete("/v1/tenants/:tenantId/media/:assetId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), assetId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const asset = await query<{ storage_file_id: string; business_id: string | null }>(`
      SELECT m.storage_file_id,m.business_id
      FROM media_assets m
      WHERE m.id=$1 AND m.tenant_id=$2 AND m.processing_status<>'deleted'
        AND NOT EXISTS(SELECT 1 FROM collection_item_media x WHERE x.media_asset_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM message_media x WHERE x.media_asset_id=m.id)
    `, [params.assetId, params.tenantId]);
    if (!asset.rows[0]) throw new ApiError(409, "MEDIA_IN_USE_OR_MISSING", "Media is referenced by another record or does not exist.");
    if (asset.rows[0].business_id) await requireBusinessAccess(request, params.tenantId, asset.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const response = await mediaFetch(params.tenantId, `/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new ApiError(502, "MEDIA_DELETE_FAILED", "Media storage deletion failed.");
    await query("UPDATE media_assets SET processing_status='deleted',updated_at=now() WHERE id=$1", [params.assetId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: asset.rows[0].business_id, action: "MEDIA_DELETED", resourceType: "media_asset", resourceId: params.assetId, request });
    reply.send({ ok: true });
  });

  app.patch("/v1/tenants/:tenantId/media/:assetId/visibility", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),assetId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);
    const input=z.object({visibility:z.enum(["private","public"])}).parse(request.body);
    const asset=await query<any>("SELECT * FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status<>'deleted'",[params.assetId,params.tenantId]);
    if(!asset.rows[0]) throw new ApiError(404,"MEDIA_NOT_FOUND","Media asset not found.");
    if(asset.rows[0].business_id) await requireBusinessAccess(request,params.tenantId,asset.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
    const response=await mediaFetch(params.tenantId,`/api/v1/files/${encodeURIComponent(asset.rows[0].storage_file_id)}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({visibility:input.visibility})});
    const body=await response.json().catch(()=>({})) as any;
    if(!response.ok) throw new ApiError(502,"MEDIA_VISIBILITY_FAILED",body?.message || "Media visibility update failed.",body);
    const file=body.file ?? body;
    const updated=await query<any>("UPDATE media_assets SET visibility=$2,public_url=$3,updated_at=now() WHERE id=$1 RETURNING *",[params.assetId,input.visibility,file.public_url ?? null]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:asset.rows[0].business_id,action:"MEDIA_VISIBILITY_UPDATED",resourceType:"media_asset",resourceId:params.assetId,safeDiff:input,request});
    reply.send({asset:updated.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/media/rotate-credential", async (request, reply) => {
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER"]);
    requireCsrf(request);
    if(!env().MEDIA_ADMIN_TOKEN) throw new ApiError(503,"MEDIA_ADMIN_NOT_CONFIGURED","Media credential rotation requires the private media admin integration.");
    const account=await mediaAccount(tenantId);
    if(!account?.external_media_user_id) throw new ApiError(404,"MEDIA_ACCOUNT_NOT_FOUND","Tenant media account is not provisioned.");
    const response=await fetch(`${mediaBase()}/api/v1/admin/users/${encodeURIComponent(account.external_media_user_id)}/rotate-key`,{method:"POST",headers:{authorization:`Bearer ${env().MEDIA_ADMIN_TOKEN}`}});
    const body=await response.json().catch(()=>({})) as any;
    if(!response.ok || !body.api_key) throw new ApiError(502,"MEDIA_ROTATION_FAILED",body?.message || "Media credential rotation failed.",body);
    await query("UPDATE tenant_media_accounts SET encrypted_api_key=$2,key_hint=$3,status='active',updated_at=now() WHERE tenant_id=$1",[tenantId,encryptSecret(body.api_key),maskSecret(body.api_key)]);
    await audit({actorUserId:principal.userId,tenantId,action:"MEDIA_CREDENTIAL_ROTATED",resourceType:"tenant_media_account",resourceId:account.id,request});
    reply.send({ok:true,keyHint:maskSecret(body.api_key)});
  });

  app.post("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId/media", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), collectionId: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({ assetId: z.string().uuid(), role: z.string().max(40).default("gallery"), displayOrder: z.number().int().min(0).default(0) }).parse(request.body);
    const scope = await query<{ business_id: string }>(`
      SELECT i.business_id FROM collection_items i JOIN collections c ON c.id=i.collection_id
      WHERE i.id=$1 AND i.collection_id=$2 AND i.tenant_id=$3
    `, [params.itemId, params.collectionId, params.tenantId]);
    if (!scope.rows[0]) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found.");
    await requireBusinessAccess(request, params.tenantId, scope.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const asset = await query("SELECT id FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status<>'deleted'", [input.assetId, params.tenantId]);
    if (!asset.rows[0]) throw new ApiError(404, "MEDIA_NOT_FOUND", "Media asset not found.");
    await query(`
      INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id,role,display_order)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(collection_item_id,media_asset_id) DO UPDATE SET role=EXCLUDED.role,display_order=EXCLUDED.display_order
    `, [params.itemId, input.assetId, params.tenantId, input.role, input.displayOrder]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: scope.rows[0].business_id, action: "ITEM_MEDIA_LINKED", resourceType: "collection_item", resourceId: params.itemId, safeDiff: input, request });
    reply.send({ ok: true });
  });
}
