import type { FastifyInstance } from "fastify";
import { decryptSecret, env, query, transaction } from "@n8n-automation/core";

const STALE_MEDIA_AGE_MINUTES = 15;
const PURGE_BATCH_SIZE = 200;

type ConversationAsset = {
  id: string;
  tenant_id: string;
  storage_file_id: string;
};

async function tenantMediaCredential(tenantId: string): Promise<string | null> {
  const result = await query<{ encrypted_api_key: string | null }>(
    "SELECT encrypted_api_key FROM tenant_media_accounts WHERE tenant_id=$1 AND status='active'",
    [tenantId],
  );
  if (result.rows[0]?.encrypted_api_key) return decryptSecret(result.rows[0].encrypted_api_key);
  return env().MEDIA_API_KEY || null;
}

async function removePhysicalAsset(asset: ConversationAsset): Promise<boolean> {
  const base = env().MEDIA_BASE_URL?.replace(/\/$/, "");
  const credential = await tenantMediaCredential(asset.tenant_id).catch(() => null);
  if (!base || !credential) return false;

  const response = await fetch(`${base}/api/v1/files/${encodeURIComponent(asset.storage_file_id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential}` },
  }).catch(() => null);

  return Boolean(response && (response.ok || response.status === 404));
}

async function removeAssetRecord(asset: ConversationAsset) {
  await transaction(async (client) => {
    await client.query("DELETE FROM message_media WHERE media_asset_id=$1", [asset.id]);
    await client.query(`
      DELETE FROM media_assets m
      WHERE m.id=$1
        AND m.metadata->>'source'='inbound_message'
        AND NOT EXISTS (SELECT 1 FROM collection_item_media cim WHERE cim.media_asset_id=m.id)
        AND NOT EXISTS (SELECT 1 FROM tenant_data_requests tdr WHERE tdr.result_media_asset_id=m.id)
    `, [asset.id]);
  });
}

async function purgeAssets(assets: ConversationAsset[]) {
  let removed = 0;
  for (const asset of assets) {
    if (!(await removePhysicalAsset(asset))) continue;
    await removeAssetRecord(asset);
    removed += 1;
  }
  return removed;
}

async function purgeTurnConversationMedia(turnId: string) {
  const assets = await query<ConversationAsset>(`
    SELECT DISTINCT ma.id,ma.tenant_id,ma.storage_file_id
    FROM messages m
    JOIN message_media mm ON mm.message_id=m.id
    JOIN media_assets ma ON ma.id=mm.media_asset_id
    WHERE m.turn_id=$1
      AND ma.metadata->>'source'='inbound_message'
  `, [turnId]);

  const removed = await purgeAssets(assets.rows);

  await query(`
    UPDATE messages
    SET metadata=(COALESCE(metadata,'{}'::jsonb)
                  - 'providerMediaId'
                  - 'providerMediaUrl'
                  - 'attachments'
                  - 'providerMimeType'
                  - 'providerFilename')
                 || jsonb_build_object('mediaIngestStatus','discarded'),
        updated_at=now()
    WHERE turn_id=$1
      AND message_type IN ('image','audio','video','document')
  `, [turnId]);

  return removed;
}

async function purgeStaleConversationMedia() {
  const assets = await query<ConversationAsset>(`
    SELECT ma.id,ma.tenant_id,ma.storage_file_id
    FROM media_assets ma
    WHERE ma.metadata->>'source'='inbound_message'
      AND ma.created_at < now()-($1||' minutes')::interval
    ORDER BY ma.created_at
    LIMIT $2
  `, [String(STALE_MEDIA_AGE_MINUTES), PURGE_BATCH_SIZE]);

  return purgeAssets(assets.rows);
}

function hideConversationMediaFromLibrary(requestUrl: string, payload: unknown) {
  const path = requestUrl.split("?")[0];
  if (!/^\/v1\/tenants\/[0-9a-f-]+\/media$/i.test(path)) return payload;

  const raw = Buffer.isBuffer(payload)
    ? payload.toString("utf8")
    : typeof payload === "string"
      ? payload
      : null;
  if (!raw) return payload;

  try {
    const body = JSON.parse(raw);
    if (!Array.isArray(body?.assets)) return payload;
    const visible = body.assets.filter((asset: any) => asset?.metadata?.source !== "inbound_message");
    const hiddenOnPage = body.assets.length - visible.length;
    body.assets = visible;
    if (typeof body.total === "number" && hiddenOnPage > 0) body.total = Math.max(0, body.total - hiddenOnPage);
    return JSON.stringify(body);
  } catch {
    return payload;
  }
}

export async function ephemeralConversationLifecycle(app: FastifyInstance) {
  let cleanupTimer: NodeJS.Timeout | null = null;

  app.addHook("onSend", async (request, _reply, payload) => {
    if (request.method !== "GET") return payload;
    return hideConversationMediaFromLibrary(request.url, payload);
  });

  app.addHook("onResponse", async (request) => {
    if (request.method !== "POST") return;
    const match = request.url.split("?")[0].match(/^\/v1\/internal\/turns\/([0-9a-f-]+)\/complete$/i);
    if (!match) return;

    try {
      await purgeTurnConversationMedia(match[1]);
    } catch (error) {
      request.log.warn({ err: error, turnId: match[1] }, "Unable to purge transient conversation media");
    }
  });

  app.addHook("onReady", async () => {
    await purgeStaleConversationMedia().catch((error) => app.log.warn({ err: error }, "Initial conversation media purge failed"));
    cleanupTimer = setInterval(() => {
      void purgeStaleConversationMedia().catch((error) => app.log.warn({ err: error }, "Conversation media purge failed"));
    }, 5 * 60 * 1000);
    cleanupTimer.unref();
  });

  app.addHook("onClose", async () => {
    if (cleanupTimer) clearInterval(cleanupTimer);
  });
}
