import { mediaApiKeyForAsset, transaction } from "@n8n-automation/core";

export async function deleteRetainedMediaAsset(input: {
  tenantId: string;
  assetId: string;
  mediaDays: number | string;
  mediaBaseUrl: string | undefined;
}): Promise<boolean> {
  return transaction(async (client) => {
    // Candidate discovery can be stale by the time this worker reaches storage.
    // Lock first, then recheck the age/state and all durable references before
    // removing bytes so message/catalog attachment cannot win in that gap.
    const selected = await client.query<{ storage_file_id: string; storage_user_id: string | null }>(`
      SELECT storage_file_id,storage_user_id FROM media_assets
      WHERE id=$1 AND tenant_id=$2 AND processing_status='ready'
        AND created_at<now()-($3||' days')::interval
      FOR UPDATE
    `, [input.assetId,input.tenantId,String(input.mediaDays)]);
    const asset = selected.rows[0];
    if (!asset) return false;
    const references = await client.query(`SELECT 1 WHERE
      EXISTS(SELECT 1 FROM collection_item_media WHERE media_asset_id=$1)
      OR EXISTS(SELECT 1 FROM message_media WHERE media_asset_id=$1)
      OR EXISTS(SELECT 1 FROM tenant_data_requests WHERE result_media_asset_id=$1)
    `, [input.assetId]);
    if (references.rows[0]) return false;

    if (input.mediaBaseUrl) {
      const credential = await mediaApiKeyForAsset(input.tenantId,asset.storage_user_id,client).catch(() => null);
      if (!credential) return false;
      const response = await fetch(`${input.mediaBaseUrl.replace(/\/$/, "")}/api/v1/files/${encodeURIComponent(asset.storage_file_id)}`, {
        method: "DELETE", headers: { authorization: `Bearer ${credential}` }, signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      if (!response || (!response.ok && response.status !== 404)) return false;
    }
    await client.query("UPDATE media_assets SET processing_status='deleted',updated_at=now() WHERE id=$1 AND tenant_id=$2", [input.assetId,input.tenantId]);
    return true;
  });
}
