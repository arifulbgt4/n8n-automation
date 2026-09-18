import type { Database } from "./client.js";
import { outboxEvents } from "./schema.js";

export type OutboxEventInput = Readonly<{
  tenantId?: string;
  aggregateType: string;
  aggregateId?: string;
  eventType: string;
  payload: Record<string, unknown>;
}>;

export async function enqueueOutboxEvent(db: Database, event: OutboxEventInput) {
  const [created] = await db
    .insert(outboxEvents)
    .values({
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      payload: event.payload,
      ...(event.tenantId ? { tenantId: event.tenantId } : {}),
      ...(event.aggregateId ? { aggregateId: event.aggregateId } : {})
    })
    .returning({ id: outboxEvents.id });

  if (!created) throw new Error("Failed to persist outbox event.");
  return created.id;
}
