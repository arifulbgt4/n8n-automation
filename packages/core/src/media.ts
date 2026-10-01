import { decryptSecret } from "./crypto.js";
import { query } from "./db.js";
import { env } from "./env.js";
import type pg from "pg";

export const CUSTOMER_MEDIA_STORAGE_BYTES = 512 * 1024 * 1024;

export function cappedCustomerMediaLimit(rawLimit: unknown): number {
  const value = rawLimit === null || rawLimit === undefined ? NaN : Number(rawLimit);
  return Number.isFinite(value)
    ? Math.max(0, Math.min(CUSTOMER_MEDIA_STORAGE_BYTES, value))
    : CUSTOMER_MEDIA_STORAGE_BYTES;
}

export async function customerMediaStorageLimit(tenantId: string): Promise<number> {
  const result = await query<{ plan_limit: unknown; override_value: unknown }>(`
    SELECT p.limits->>'mediaStorageBytes' AS plan_limit,
      (SELECT value FROM tenant_limit_overrides o
       WHERE o.tenant_id=t.id AND o.key='mediaStorageBytes'
         AND (o.expires_at IS NULL OR o.expires_at>now()) LIMIT 1) AS override_value
    FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1
  `, [tenantId]);
  const row = result.rows[0];
  if (!row) throw new Error("Tenant not found");
  return cappedCustomerMediaLimit(row.override_value ?? row.plan_limit);
}

export async function assertCustomerMediaCapacity(tenantId: string, incomingBytes: number): Promise<void> {
  const limit = await customerMediaStorageLimit(tenantId);
  const result = await query<{ used: string }>(
    "SELECT COALESCE(sum(size_bytes),0)::text AS used FROM media_assets WHERE tenant_id=$1 AND processing_status<>'deleted'",
    [tenantId],
  );
  const used = Number(result.rows[0]?.used ?? 0);
  if (used + incomingBytes > limit) {
    throw new Error(`Media storage limit reached (${used} of ${limit} bytes used)`);
  }
}

export function sharedMediaApiKey(): string {
  const key = env().MEDIA_API_KEY;
  if (!key) throw new Error("Shared Media Storage credential is not configured");
  return key;
}

export function chooseMediaApiKey(
  storageUserId: string | null | undefined,
  sharedKey: string | null | undefined,
  legacy: { userId: string | null; key: string | null } | null,
): string {
  if (legacy?.key && (!storageUserId || storageUserId === legacy.userId)) return legacy.key;
  if (sharedKey) return sharedKey;
  throw new Error("Media Storage credential is not configured");
}

// Existing tenant Media users are retained only to read/delete files written before
// the shared account cutover. New files must always use sharedMediaApiKey().
export async function mediaApiKeyForAsset(
  tenantId: string,
  storageUserId: string | null | undefined,
  client?: Pick<pg.PoolClient, "query">,
): Promise<string> {
  const sql = "SELECT external_media_user_id,encrypted_api_key FROM tenant_media_accounts WHERE tenant_id=$1";
  const result = client ? await client.query<{ external_media_user_id: string | null; encrypted_api_key: string | null }>(
    sql,
    [tenantId],
  ) : await query<{ external_media_user_id: string | null; encrypted_api_key: string | null }>(
    sql,
    [tenantId],
  );
  const legacy = result.rows[0];
  const legacyKey = legacy?.encrypted_api_key && (!storageUserId || storageUserId === legacy.external_media_user_id)
    ? decryptSecret(legacy.encrypted_api_key)
    : null;
  return chooseMediaApiKey(storageUserId, env().MEDIA_API_KEY, legacy
    ? { userId: legacy.external_media_user_id, key: legacyKey }
    : null);
}
