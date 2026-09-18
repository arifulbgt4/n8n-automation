import { eq, type SQL, type AnyColumn } from "drizzle-orm";
import type { TenantContext, UUID } from "@n8nauto/contracts";

export function requireTenantId(context: TenantContext): UUID {
  if (!context.tenantId) {
    throw new Error("Tenant context is required for tenant-owned data access.");
  }
  return context.tenantId;
}

export function tenantPredicate(column: AnyColumn, context: TenantContext): SQL {
  return eq(column, requireTenantId(context));
}
