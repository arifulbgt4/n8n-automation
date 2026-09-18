import type { Database } from "./client.js";
import { auditEvents } from "./schema.js";

export type AuditEventInput = Readonly<{
  tenantId?: string;
  actorUserId?: string;
  actorType: "USER" | "PLATFORM_ADMIN" | "SERVICE" | "SYSTEM";
  action: string;
  resourceType?: string;
  resourceId?: string;
  correlationId: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}>;

export async function writeAuditEvent(db: Database, event: AuditEventInput) {
  await db.insert(auditEvents).values({
    tenantId: event.tenantId,
    actorUserId: event.actorUserId,
    actorType: event.actorType,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    correlationId: event.correlationId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    metadata: event.metadata ?? {}
  });
}
