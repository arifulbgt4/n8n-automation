import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";

export async function collectionMediaRoutes(app: FastifyInstance) {
  app.put("/v1/tenants/:tenantId/collections/:collectionId/items/:itemId/media", async (request, reply) => {
    const params = z.object({
      tenantId: z.string().uuid(),
      collectionId: z.string().uuid(),
      itemId: z.string().uuid(),
    }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    requireCsrf(request);
    const input = z.object({ mediaAssetIds: z.array(z.string().uuid()).max(50) }).parse(request.body);

    const collection = await query<any>(
      "SELECT id,business_id FROM collections WHERE id=$1 AND tenant_id=$2 AND status<>'archived'",
      [params.collectionId, params.tenantId],
    );
    if (!collection.rows[0]) throw new ApiError(404, "COLLECTION_NOT_FOUND", "Collection not found.");
    await requireBusinessAccess(request, params.tenantId, collection.rows[0].business_id, ["OWNER", "ADMIN", "STAFF"]);

    const item = await query<any>(
      "SELECT id FROM collection_items WHERE id=$1 AND collection_id=$2 AND tenant_id=$3 AND status<>'deleted'",
      [params.itemId, params.collectionId, params.tenantId],
    );
    if (!item.rows[0]) throw new ApiError(404, "ITEM_NOT_FOUND", "Collection item not found.");

    const ids = [...new Set(input.mediaAssetIds)];
    if (ids.length) {
      const assets = await query<any>(`
        SELECT id FROM media_assets
        WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND processing_status='ready'
          AND (business_id IS NULL OR business_id=$3)
      `, [params.tenantId, ids, collection.rows[0].business_id]);
      if (assets.rows.length !== ids.length) {
        throw new ApiError(400, "MEDIA_SCOPE_INVALID", "One or more media assets are missing, unavailable, or belong to another business.");
      }
    }

    await transaction(async (client) => {
      await client.query("DELETE FROM collection_item_media WHERE collection_item_id=$1", [params.itemId]);
      for (let index = 0; index < ids.length; index += 1) {
        await client.query(`
          INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id,role,display_order)
          VALUES ($1,$2,$3,$4,$5)
        `, [params.itemId, ids[index], params.tenantId, index === 0 ? "primary" : "gallery", index]);
      }
    });

    await audit({
      actorUserId: principal.userId,
      tenantId: params.tenantId,
      businessId: collection.rows[0].business_id,
      action: "COLLECTION_ITEM_MEDIA_UPDATED",
      resourceType: "collection_item",
      resourceId: params.itemId,
      safeDiff: { mediaAssetIds: ids },
      request,
    });
    reply.send({ ok: true, mediaAssetIds: ids });
  });
}
