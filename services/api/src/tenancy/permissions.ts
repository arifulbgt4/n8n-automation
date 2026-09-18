import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  businessMembershipRestrictions,
  platformAdmins,
  tenantMemberships
} from "../db/schema.js";

export const TENANT_ROLES = ["OWNER", "ADMIN", "STAFF", "VIEWER"] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const PLATFORM_ADMIN_ROLES = [
  "SUPER_ADMIN",
  "OPS_ADMIN",
  "SUPPORT_ADMIN",
  "BILLING_ADMIN"
] as const;
export type PlatformAdminRole = (typeof PLATFORM_ADMIN_ROLES)[number];

const roleRank: Record<TenantRole, number> = {
  VIEWER: 1,
  STAFF: 2,
  ADMIN: 3,
  OWNER: 4
};

export function isTenantRole(value: string): value is TenantRole {
  return (TENANT_ROLES as readonly string[]).includes(value);
}

export async function requireTenantMembership(
  db: Database,
  userId: string,
  tenantId: string,
  minimumRole: TenantRole = "VIEWER"
) {
  const [membership] = await db
    .select()
    .from(tenantMemberships)
    .where(
      and(
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.status, "ACTIVE")
      )
    )
    .limit(1);

  if (!membership || !isTenantRole(membership.role) || roleRank[membership.role] < roleRank[minimumRole]) {
    const error = new Error("Tenant permission denied.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }

  return membership;
}

export async function canAccessBusiness(
  db: Database,
  membershipId: string,
  businessId: string
) {
  const rows = await db
    .select({ businessId: businessMembershipRestrictions.businessId })
    .from(businessMembershipRestrictions)
    .where(eq(businessMembershipRestrictions.membershipId, membershipId));

  return rows.length === 0 || rows.some((row) => row.businessId === businessId);
}

export async function requirePlatformAdmin(db: Database, userId: string) {
  const [admin] = await db
    .select()
    .from(platformAdmins)
    .where(and(eq(platformAdmins.userId, userId), eq(platformAdmins.status, "ACTIVE")))
    .limit(1);

  if (!admin) {
    const error = new Error("Platform administrator permission required.") as Error & {
      statusCode?: number;
    };
    error.statusCode = 403;
    throw error;
  }
  return admin;
}
