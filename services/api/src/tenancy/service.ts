import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  tenantInvitations,
  tenantMemberships,
  tenants
} from "../db/schema.js";
import type { TenantRole } from "./permissions.js";
import { requireTenantMembership } from "./permissions.js";
import { enqueueOutboxEvent } from "../db/outbox.js";
import { writeAuditEvent } from "../db/audit.js";

function slugify(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createTenant(
  db: Database,
  input: { userId: string; name: string; correlationId: string }
) {
  const slug = `${slugify(input.name) || "tenant"}-${randomBytes(4).toString("hex")}`;

  const tenant = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(tenants)
      .values({ name: input.name.trim(), slug })
      .returning();

    if (!created) throw new Error("Tenant creation failed.");

    await tx.insert(tenantMemberships).values({
      tenantId: created.id,
      userId: input.userId,
      role: "OWNER"
    });

    return created;
  });

  await writeAuditEvent(db, {
    tenantId: tenant.id,
    actorUserId: input.userId,
    actorType: "USER",
    action: "TENANT_CREATED",
    resourceType: "tenant",
    resourceId: tenant.id,
    correlationId: input.correlationId
  });

  return tenant;
}

export async function listTenantsForUser(db: Database, userId: string) {
  return db
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      status: tenants.status,
      role: tenantMemberships.role
    })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
    .where(
      and(
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "ACTIVE")
      )
    );
}

export async function inviteTenantMember(
  db: Database,
  input: {
    tenantId: string;
    actorUserId: string;
    email: string;
    role: TenantRole;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const [invitation] = await db
    .insert(tenantInvitations)
    .values({
      tenantId: input.tenantId,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      tokenHash: hashToken(token),
      expiresAt,
      invitedByUserId: input.actorUserId
    })
    .returning();

  if (!invitation) throw new Error("Invitation creation failed.");

  await enqueueOutboxEvent(db, {
    tenantId: input.tenantId,
    aggregateType: "tenant_invitation",
    aggregateId: invitation.id,
    eventType: "TENANT_INVITATION_EMAIL_REQUESTED",
    payload: {
      to: invitation.email,
      invitationToken: token,
      expiresAt: expiresAt.toISOString()
    }
  });

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "TENANT_MEMBER_INVITED",
    resourceType: "tenant_invitation",
    resourceId: invitation.id,
    correlationId: input.correlationId,
    metadata: { email: invitation.email, role: invitation.role }
  });

  return { id: invitation.id, expiresAt };
}

export async function acceptTenantInvitation(
  db: Database,
  input: {
    token: string;
    userId: string;
    userEmail: string;
    correlationId: string;
  }
) {
  const [invitation] = await db
    .select()
    .from(tenantInvitations)
    .where(
      and(
        eq(tenantInvitations.tokenHash, hashToken(input.token)),
        eq(tenantInvitations.status, "PENDING"),
        gt(tenantInvitations.expiresAt, new Date())
      )
    )
    .limit(1);

  if (!invitation || invitation.email !== input.userEmail.trim().toLowerCase()) {
    const error = new Error("Invitation is invalid, expired, or belongs to another account.") as Error & {
      statusCode?: number;
    };
    error.statusCode = 400;
    throw error;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(tenantMemberships)
      .values({
        tenantId: invitation.tenantId,
        userId: input.userId,
        role: invitation.role
      })
      .onConflictDoUpdate({
        target: [tenantMemberships.tenantId, tenantMemberships.userId],
        set: {
          role: invitation.role,
          status: "ACTIVE",
          updatedAt: new Date()
        }
      });

    await tx
      .update(tenantInvitations)
      .set({ status: "ACCEPTED", acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(tenantInvitations.id, invitation.id));
  });

  await writeAuditEvent(db, {
    tenantId: invitation.tenantId,
    actorUserId: input.userId,
    actorType: "USER",
    action: "TENANT_INVITATION_ACCEPTED",
    resourceType: "tenant_invitation",
    resourceId: invitation.id,
    correlationId: input.correlationId
  });

  return invitation.tenantId;
}
