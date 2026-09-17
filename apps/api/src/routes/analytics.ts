import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "@n8n-automation/core";
import { requireTenant } from "../lib.js";

function defaultFrom() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 30);
  return date.toISOString();
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/analytics/overview", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    const q = z.object({
      businessId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
      from: z.string().datetime().default(defaultFrom()),
      to: z.string().datetime().default(() => new Date().toISOString()),
    }).parse(request.query);

    const [usage, conversations, outcomes, channels] = await Promise.all([
      query(`
        SELECT event_type,SUM(quantity)::numeric AS quantity,SUM(COALESCE(estimated_cost,0))::numeric AS estimated_cost
        FROM usage_events
        WHERE tenant_id=$1 AND occurred_at >= $2 AND occurred_at <= $3
          AND ($4::uuid IS NULL OR business_id=$4) AND ($5::uuid IS NULL OR channel_account_id=$5)
        GROUP BY event_type ORDER BY event_type
      `, [tenantId, q.from, q.to, q.businessId ?? null, q.channelId ?? null]),
      query(`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE mode='AI')::int AS ai,
          count(*) FILTER (WHERE mode='HUMAN')::int AS human,
          count(*) FILTER (WHERE status='open')::int AS open
        FROM conversations WHERE tenant_id=$1
          AND created_at >= $2 AND created_at <= $3
          AND ($4::uuid IS NULL OR business_id=$4) AND ($5::uuid IS NULL OR channel_account_id=$5)
      `, [tenantId, q.from, q.to, q.businessId ?? null, q.channelId ?? null]),
      query(`
        SELECT
          (SELECT count(*)::int FROM orders WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR business_id=$4) AND ($5::uuid IS NULL OR channel_account_id=$5)) AS orders,
          (SELECT count(*)::int FROM bookings WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR business_id=$4) AND ($5::uuid IS NULL OR channel_account_id=$5)) AS bookings,
          (SELECT count(*)::int FROM leads WHERE tenant_id=$1 AND created_at BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR business_id=$4) AND ($5::uuid IS NULL OR channel_account_id=$5)) AS leads
      `, [tenantId, q.from, q.to, q.businessId ?? null, q.channelId ?? null]),
      query(`
        SELECT ca.id,ca.platform,ca.name,
          count(m.id) FILTER (WHERE m.direction='INBOUND')::int AS inbound_messages,
          count(m.id) FILTER (WHERE m.direction='OUTBOUND')::int AS outbound_messages,
          count(DISTINCT m.conversation_id)::int AS conversations
        FROM channel_accounts ca LEFT JOIN messages m ON m.channel_account_id=ca.id AND m.created_at BETWEEN $2 AND $3
        WHERE ca.tenant_id=$1 AND ($4::uuid IS NULL OR ca.business_id=$4) AND ($5::uuid IS NULL OR ca.id=$5)
        GROUP BY ca.id,ca.platform,ca.name ORDER BY ca.name
      `, [tenantId, q.from, q.to, q.businessId ?? null, q.channelId ?? null]),
    ]);

    const metrics = Object.fromEntries(usage.rows.map((row: any) => [row.event_type, { quantity: Number(row.quantity), estimatedCost: Number(row.estimated_cost) }]));
    reply.send({ range: { from: q.from, to: q.to }, metrics, conversations: conversations.rows[0], outcomes: outcomes.rows[0], channels: channels.rows });
  });

  app.get("/v1/tenants/:tenantId/analytics/timeseries", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    const q = z.object({
      from: z.string().datetime().default(defaultFrom()),
      to: z.string().datetime().default(() => new Date().toISOString()),
      eventType: z.string().max(120).optional(),
      businessId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
    }).parse(request.query);
    const result = await query(`
      SELECT date_trunc('day',occurred_at) AS day,event_type,SUM(quantity)::numeric AS quantity,SUM(COALESCE(estimated_cost,0))::numeric AS estimated_cost
      FROM usage_events WHERE tenant_id=$1 AND occurred_at BETWEEN $2 AND $3
        AND ($4::text IS NULL OR event_type=$4) AND ($5::uuid IS NULL OR business_id=$5) AND ($6::uuid IS NULL OR channel_account_id=$6)
      GROUP BY day,event_type ORDER BY day,event_type
    `, [tenantId, q.from, q.to, q.eventType ?? null, q.businessId ?? null, q.channelId ?? null]);
    reply.send({ points: result.rows });
  });
}
