import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, sha256 } from "@n8n-automation/core";
import { ApiError, requireCsrf, requireTenant } from "../lib.js";
import { tenantLimit } from "../limits.js";
import { readImageDimensions } from "../image-metadata.js";

const uploadPath = /^\/v1\/tenants\/([0-9a-f-]+)\/media$/i;
const DEFAULT_MAX_IMAGE_MEGAPIXELS = 10;
const DEFAULT_MAX_IMAGE_ASSETS = 100;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MEDIA_STORAGE_BYTES = 512 * 1024 * 1024;

type UploadPolicyMarker = {
  tenantId: string;
  businessId: string | null;
  checksum: string;
  isImage: boolean;
  width?: number;
  height?: number;
  megapixels?: number;
};

async function numericLimit(tenantId: string, key: string, fallback: number) {
  const value = await tenantLimit(tenantId, key).catch(() => null);
  return value == null ? fallback : Math.max(0, Number(value));
}

async function managedImageCount(tenantId: string) {
  const result = await query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM media_assets m
    WHERE m.tenant_id=$1
      AND m.processing_status<>'deleted'
      AND m.mime_type LIKE 'image/%'
      AND (
        m.metadata->>'origin'='customer_upload'
        OR EXISTS (SELECT 1 FROM collection_item_media cim WHERE cim.media_asset_id=m.id)
        OR NOT EXISTS (SELECT 1 FROM message_media mm WHERE mm.media_asset_id=m.id)
      )
  `, [tenantId]);
  return Number(result.rows[0]?.count ?? 0);
}

async function mediaBytesUsed(tenantId: string) {
  const result = await query<{ used: string }>(`
    SELECT COALESCE(sum(size_bytes),0)::text AS used
    FROM media_assets
    WHERE tenant_id=$1 AND processing_status<>'deleted'
  `, [tenantId]);
  return Number(result.rows[0]?.used ?? 0);
}

async function findDuplicate(tenantId: string, businessId: string | null, checksum: string) {
  const result = await query<any>(`
    SELECT * FROM media_assets
    WHERE tenant_id=$1 AND content_hash=$2 AND processing_status='ready'
      AND (($3::uuid IS NULL AND business_id IS NULL) OR business_id=$3)
    ORDER BY created_at
    LIMIT 1
  `, [tenantId, checksum, businessId]);
  return result.rows[0] ?? null;
}

export async function mediaUploadPolicyRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/media/limits", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    const [maxImageMegapixels,maxImageAssets,maxImageBytes,mediaStorageBytes,imageAssets,storageBytes] = await Promise.all([
      numericLimit(tenantId,"maxImageMegapixels",DEFAULT_MAX_IMAGE_MEGAPIXELS),
      numericLimit(tenantId,"maxImageAssets",DEFAULT_MAX_IMAGE_ASSETS),
      numericLimit(tenantId,"maxImageBytes",DEFAULT_MAX_IMAGE_BYTES),
      numericLimit(tenantId,"mediaStorageBytes",DEFAULT_MEDIA_STORAGE_BYTES),
      managedImageCount(tenantId),
      mediaBytesUsed(tenantId),
    ]);
    reply.send({
      limits:{maxImageMegapixels,maxImageAssets,maxImageBytes,mediaStorageBytes},
      usage:{imageAssets,storageBytes},
      remaining:{
        imageAssets:Math.max(0,maxImageAssets-imageAssets),
        storageBytes:Math.max(0,mediaStorageBytes-storageBytes),
      },
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST") return;
    const path = request.url.split("?")[0];
    const match = path.match(uploadPath);
    if (!match) return;

    const tenantId = z.string().uuid().parse(match[1]);
    await requireTenant(request, tenantId, ["OWNER","ADMIN","STAFF"]);
    requireCsrf(request);

    const businessHeader = request.headers["x-business-id"];
    const businessId = businessHeader ? z.string().uuid().parse(String(businessHeader)) : null;
    const originalFile = (request as any).file?.bind(request);
    if (!originalFile) throw new ApiError(500,"MEDIA_MULTIPART_UNAVAILABLE","Multipart upload support is unavailable.");

    let file: any;
    let bytes: Buffer;
    try {
      file = await originalFile({ limits:{ files:1, fileSize:512*1024*1024 } });
      if (!file) throw new ApiError(400,"FILE_REQUIRED","A file is required.");
      bytes = await file.toBuffer();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(413,"MEDIA_FILE_TOO_LARGE","The uploaded file exceeds the allowed request size.");
    }

    const checksum = sha256(bytes);
    const duplicate = await findDuplicate(tenantId,businessId,checksum);
    if (duplicate) {
      (request as any).mediaUploadPolicy = { tenantId,businessId,checksum,isImage:String(file.mimetype||"").startsWith("image/") } satisfies UploadPolicyMarker;
      return reply.status(200).send({asset:duplicate,deduplicated:true});
    }

    const isImage = String(file.mimetype||"").toLowerCase().startsWith("image/");
    const marker: UploadPolicyMarker = {tenantId,businessId,checksum,isImage};

    if (isImage) {
      const [maxImageMegapixels,maxImageAssets,maxImageBytes] = await Promise.all([
        numericLimit(tenantId,"maxImageMegapixels",DEFAULT_MAX_IMAGE_MEGAPIXELS),
        numericLimit(tenantId,"maxImageAssets",DEFAULT_MAX_IMAGE_ASSETS),
        numericLimit(tenantId,"maxImageBytes",DEFAULT_MAX_IMAGE_BYTES),
      ]);
      if (bytes.length > maxImageBytes) {
        throw new ApiError(413,"IMAGE_FILE_SIZE_LIMIT",`Images may be at most ${(maxImageBytes/1024/1024).toFixed(0)} MB on this package.`,{limitBytes:maxImageBytes,actualBytes:bytes.length});
      }

      let dimensions;
      try {
        dimensions = readImageDimensions(bytes,file.mimetype);
      } catch (error) {
        throw new ApiError(400,"IMAGE_FORMAT_UNSUPPORTED","Image dimensions could not be safely verified. Use JPEG, PNG, WebP, or GIF.",{detail:error instanceof Error?error.message:String(error)});
      }
      if (dimensions.megapixels > maxImageMegapixels) {
        throw new ApiError(413,"IMAGE_MEGAPIXEL_LIMIT",`Images may be at most ${maxImageMegapixels} megapixels on this package.`,{limitMegapixels:maxImageMegapixels,width:dimensions.width,height:dimensions.height,actualMegapixels:Number(dimensions.megapixels.toFixed(3))});
      }
      const currentImages = await managedImageCount(tenantId);
      if (currentImages >= maxImageAssets) {
        throw new ApiError(402,"IMAGE_COUNT_LIMIT_REACHED",`This package allows up to ${maxImageAssets} stored images. Delete unused images or upgrade the package.`,{limit:maxImageAssets,current:currentImages});
      }
      marker.width=dimensions.width;
      marker.height=dimensions.height;
      marker.megapixels=dimensions.megapixels;
    }

    const storageLimit = await numericLimit(tenantId,"mediaStorageBytes",DEFAULT_MEDIA_STORAGE_BYTES);
    const storageUsed = await mediaBytesUsed(tenantId);
    if (storageUsed + bytes.length > storageLimit) {
      throw new ApiError(402,"MEDIA_STORAGE_LIMIT_REACHED","Media storage limit reached for this package.",{limitBytes:storageLimit,usedBytes:storageUsed,incomingBytes:bytes.length});
    }

    (request as any).mediaUploadPolicy = marker;
    // The guard consumed the multipart stream. The existing media route can keep its
    // stable implementation by receiving a synthetic file part backed by the verified buffer.
    (request as any).file = async () => ({
      fieldname:file.fieldname,
      filename:file.filename,
      encoding:file.encoding,
      mimetype:file.mimetype,
      fields:file.fields,
      toBuffer:async()=>bytes,
    });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const marker = (request as any).mediaUploadPolicy as UploadPolicyMarker | undefined;
    if (!marker || reply.statusCode >= 400) return payload;
    try {
      const raw = Buffer.isBuffer(payload) ? payload.toString("utf8") : typeof payload === "string" ? payload : null;
      if (!raw) return payload;
      const body = JSON.parse(raw);
      const assetId = body?.asset?.id;
      if (!assetId) return payload;
      await query(`
        UPDATE media_assets
        SET metadata=COALESCE(metadata,'{}'::jsonb)||$3::jsonb,updated_at=now()
        WHERE id=$1 AND tenant_id=$2
      `,[assetId,marker.tenantId,JSON.stringify({origin:"customer_upload",width:marker.width??null,height:marker.height??null,megapixels:marker.megapixels??null})]);
    } catch (error) {
      request.log.warn({err:error},"Unable to mark customer media upload metadata");
    }
    return payload;
  });
}
