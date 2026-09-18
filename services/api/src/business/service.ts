import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  businessMembershipRestrictions,
  businesses
} from "../db/schema.js";
import { requireTenantMembership } from "../tenancy/permissions.js";
import { writeAuditEvent } from "../db/audit.js";

export type BusinessInput = Readonly<{
  name: string;
  businessTypeHint?: string | null;
  timezone: string;
  currency: string;
  locale: string;
  settings?: Record<string, unknown>;
}>;

export async function listBusinesses(
  db: Database,
  userId: string,
  tenantId: string
) {
  const membership = await requireTenantMembership(db, userId, tenantId);

  const restrictions = await db
    .select({ businessId: businessMembershipRestrictions.businessId })
    .from(businessMembershipRestrictions)
    .where(eq(businessMembershipRestrictions.membershipId, membership.id));

  if (restrictions.length === 0) {
    return db
      .select()
      .from(businesses)
      .where(and(eq(businesses.tenantId, tenantId), eq(businesses.status, "ACTIVE")));
  }

  return db
    .select()
    .from(businesses)
    .where(
      and(
        eq(businesses.tenantId, tenantId),
        eq(businesses.status, "ACTIVE"),
        inArray(businesses.id, restrictions.map((row) => row.businessId))
      )
    );
}

export async function requireBusinessAccess(
  db: Database,
  userId: string,
  tenantId: string,
  businessId: string
) {
  const membership = await requireTenantMembership(db, userId, tenantId);
  const [business] = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenantId)))
    .limit(1);

  if (!business) {
    const error = new Error("Business not found.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }

  const restrictions = await db
    .select({ businessId: businessMembershipRestrictions.businessId })
    .from(businessMembershipRestrictions)
    .where(eq(businessMembershipRestrictions.membershipId, membership.id));

  if (restrictions.length > 0 && !restrictions.some((row) => row.businessId === businessId)) {
    const error = new Error("Business permission denied.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }

  return business;
}

export async function createBusiness(
  db: Database,
  input: BusinessInput & {
    tenantId: string;
    actorUserId: string;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");

  const [business] = await db
    .insert(businesses)
    .values({
      tenantId: input.tenantId,
      name: input.name.trim(),
      timezone: input.timezone,
      currency: input.currency.toUpperCase(),
      locale: input.locale,
      settings: input.settings ?? {},
      ...(input.businessTypeHint ? { businessTypeHint: input.businessTypeHint } : {})
    })
    .returning();

  if (!business) throw new Error("Business creation failed.");

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "BUSINESS_CREATED",
    resourceType: "business",
    resourceId: business.id,
    correlationId: input.correlationId
  });

  return business;
}

export async function updateBusiness(
  db: Database,
  input: Partial<BusinessInput> & {
    tenantId: string;
    businessId: string;
    actorUserId: string;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");
  await requireBusinessAccess(db, input.actorUserId, input.tenantId, input.businessId);

  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = input.name.trim();
  if (input.businessTypeHint !== undefined) values.businessTypeHint = input.businessTypeHint;
  if (input.timezone !== undefined) values.timezone = input.timezone;
  if (input.currency !== undefined) values.currency = input.currency.toUpperCase();
  if (input.locale !== undefined) values.locale = input.locale;
  if (input.settings !== undefined) values.settings = input.settings;

  const [business] = await db
    .update(businesses)
    .set(values)
    .where(and(eq(businesses.id, input.businessId), eq(businesses.tenantId, input.tenantId)))
    .returning();

  if (!business) throw new Error("Business update failed.");

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "BUSINESS_UPDATED",
    resourceType: "business",
    resourceId: business.id,
    correlationId: input.correlationId
  });

  return business;
}

export async function archiveBusiness(
  db: Database,
  input: {
    tenantId: string;
    businessId: string;
    actorUserId: string;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "OWNER");
  await requireBusinessAccess(db, input.actorUserId, input.tenantId, input.businessId);

  await db
    .update(businesses)
    .set({ status: "ARCHIVED", updatedAt: new Date() })
    .where(and(eq(businesses.id, input.businessId), eq(businesses.tenantId, input.tenantId)));

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "BUSINESS_ARCHIVED",
    resourceType: "business",
    resourceId: input.businessId,
    correlationId: input.correlationId
  });
}
