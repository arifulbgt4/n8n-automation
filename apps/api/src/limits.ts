import { query } from "@n8n-automation/core";
import { ApiError } from "./lib.js";

export async function tenantLimit(tenantId: string, key: string): Promise<number | null> {
  const result = await query<any>(`
    SELECT p.limits,
      (SELECT value FROM tenant_limit_overrides o
        WHERE o.tenant_id=t.id AND o.key=$2 AND (o.expires_at IS NULL OR o.expires_at>now())
        LIMIT 1) AS override_value
    FROM tenants t
    LEFT JOIN plans p ON p.id=t.plan_id
    WHERE t.id=$1
  `, [tenantId,key]);
  const row = result.rows[0];
  if (!row) throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
  if (row.override_value !== null && row.override_value !== undefined) return Number(row.override_value);
  const raw = row.limits?.[key];
  return raw === null || raw === undefined ? null : Number(raw);
}

export async function assertTenantCountLimit(
  tenantId: string,
  key: string,
  currentCountSql: string,
  values: unknown[] = [],
): Promise<void> {
  const limit = await tenantLimit(tenantId,key);
  if (limit === null || !Number.isFinite(limit)) return;
  const count = await query<{ count: string }>(currentCountSql,[tenantId,...values]);
  if (Number(count.rows[0]?.count ?? 0) >= limit) {
    throw new ApiError(402, "PLAN_LIMIT_REACHED", `The ${key} plan limit has been reached.`, { key, limit });
  }
}

export async function assertMonthlyUsageLimit(tenantId: string, eventType: string, key: string): Promise<void> {
  const limit = await tenantLimit(tenantId,key);
  if (limit === null || !Number.isFinite(limit)) return;
  const result = await query<{ quantity: string }>(`
    SELECT COALESCE(sum(quantity),0)::text AS quantity
    FROM usage_events
    WHERE tenant_id=$1 AND event_type=$2
      AND occurred_at>=date_trunc('month',now())
  `, [tenantId,eventType]);
  const used = Number(result.rows[0]?.quantity ?? 0);
  if (used >= limit) {
    throw new ApiError(402, "USAGE_LIMIT_REACHED", `The monthly ${key} limit has been reached.`, { key, limit, used });
  }
}

export async function assertMediaStorageLimit(tenantId: string, incomingBytes: number): Promise<void> {
  const limit = await tenantLimit(tenantId,"mediaStorageBytes");
  if (limit === null || !Number.isFinite(limit)) return;
  const result = await query<{ used: string }>(`
    SELECT COALESCE(sum(size_bytes),0)::text AS used
    FROM media_assets
    WHERE tenant_id=$1 AND processing_status<>'deleted'
  `, [tenantId]);
  const used = Number(result.rows[0]?.used ?? 0);
  if (used + incomingBytes > limit) {
    throw new ApiError(402, "MEDIA_STORAGE_LIMIT_REACHED", "The media storage plan limit would be exceeded.", { limit, used, incomingBytes });
  }
}

export async function maxImagesPerResponse(tenantId: string): Promise<number> {
  const limit = await tenantLimit(tenantId,"maxImagesPerResponse");
  return Math.max(1, Math.min(20, Number.isFinite(limit ?? NaN) ? Number(limit) : 5));
}

export async function assertChannelOverrideWithinPlan(tenantId: string, key: string, value: number): Promise<void> {
  const mapping: Record<string,string> = {
    maxImagesPerResponse: "maxImagesPerResponse",
  };
  const planKey = mapping[key];
  if (!planKey) return;
  const ceiling = await tenantLimit(tenantId,planKey);
  if (ceiling !== null && Number.isFinite(ceiling) && value > ceiling) {
    throw new ApiError(400, "LIMIT_ABOVE_PLAN", `Requested ${key} exceeds the tenant plan ceiling.`, { key, requested: value, ceiling });
  }
}
