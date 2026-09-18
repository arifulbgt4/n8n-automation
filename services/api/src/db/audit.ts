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
    actorType: event.actorType,
    action: event.action,
    correlationId: event.correlationId,
    metadata: event.metadata ?? {},
    ...(event.tenantId ? { tenantId: event.tenantId } : {}),
    ...(event.actorUserId ? { actorUserId: event.actorUserId } : {}),
    ...(event.resourceType ? { resourceType: event.resourceType } : {}),
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.ipAddress ? { ipAddress: event.ipAddress } : {}),
    ...(event.userAgent ? { userAgent: event.userAgent } : {})
  });
}
