import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, query, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";

async function internalOrTenant(request: FastifyRequest, tenantId: string, roles: Array<"OWNER" | "ADMIN" | "STAFF" | "VIEWER"> = ["OWNER","ADMIN","STAFF"]) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (bearer && bearer === env().INTERNAL_SERVICE_AUTH_SECRET) return { internal: true, userId: null as string | null };
  const principal = await requireAuth(request);
  await requireTenant(request, tenantId, roles);
  requireCsrf(request);
  return { internal: false, userId: principal.userId };
}

async function idempotent<T>(tenantId: string, scope: string, key: string | undefined, work: () => Promise<T>): Promise<T> {
  if (!key) return work();
  const existing = await query<{ status: string; response_json: T | null }>("SELECT status,response_json FROM idempotency_keys WHERE tenant_id=$1 AND scope=$2 AND key=$3", [tenantId, scope, key]);
  if (existing.rows[0]?.status === "completed" && existing.rows[0].response_json) return existing.rows[0].response_json;
  if (existing.rows[0]?.status === "processing") throw new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "The same operation is already in progress.");
  await query(`INSERT INTO idempotency_keys(tenant_id,scope,key,status) VALUES ($1,$2,$3,'processing') ON CONFLICT(tenant_id,scope,key) DO UPDATE SET status='processing',updated_at=now()`, [tenantId, scope, key]);
  try {
    const result = await work();
    await query("UPDATE idempotency_keys SET status='completed',response_json=$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND scope=$2 AND key=$3", [tenantId, scope, key, JSON.stringify(result)]);
    return result;
  } catch (error) {
    await query("UPDATE idempotency_keys SET status='failed',updated_at=now() WHERE tenant_id=$1 AND scope=$2 AND key=$3", [tenantId, scope, key]).catch(() => undefined);
    throw error;
  }
}

async function ensureBusiness(tenantId: string, businessId: string) {
  const business = await query<{ id: string; currency: string }>("SELECT id,currency FROM businesses WHERE id=$1 AND tenant_id=$2 AND status='active'", [businessId, tenantId]);
  if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
  return business.rows[0];
}

export async function actionRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/orders", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional(), channelId: z.string().uuid().optional(), status: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const result = await query(`
      SELECT o.*,ca.platform,ca.name AS channel_name,
        COALESCE((SELECT jsonb_agg(oi ORDER BY oi.created_at) FROM order_items oi WHERE oi.order_id=o.id),'[]'::jsonb) AS items
      FROM orders o LEFT JOIN channel_accounts ca ON ca.id=o.channel_account_id
      WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.business_id=$2) AND ($3::uuid IS NULL OR o.channel_account_id=$3) AND ($4::text IS NULL OR o.status=$4)
        AND ($5::uuid[] IS NULL OR o.business_id=ANY($5::uuid[]))
      ORDER BY o.created_at DESC LIMIT $6 OFFSET $7
    `, [tenantId, q.businessId ?? null, q.channelId ?? null, q.status ?? null, scope, q.limit, q.offset]);
    reply.send({ orders: result.rows, limit: q.limit, offset: q.offset });
  });

  app.post("/v1/tenants/:tenantId/orders", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const auth = await internalOrTenant(request, tenantId);
    const input = z.object({
      businessId: z.string().uuid(),
      channelAccountId: z.string().uuid().nullable().optional(),
      conversationId: z.string().uuid().nullable().optional(),
      contactId: z.string().uuid().nullable().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      customer: z.record(z.string(), z.unknown()).default({}),
      delivery: z.record(z.string(), z.unknown()).default({}),
      payment: z.record(z.string(), z.unknown()).default({}),
      source: z.enum(["ai", "human", "api", "panel"]).default(auth.internal ? "ai" : "panel"),
      items: z.array(z.object({ collectionItemId: z.string().uuid().nullable().optional(), title: z.string().min(1).max(300), sku: z.string().max(120).nullable().optional(), quantity: z.number().positive(), unitPrice: z.number().nonnegative(), attributes: z.record(z.string(), z.unknown()).default({}) })).min(1).max(100),
    }).parse(request.body);
    if (!auth.internal) await requireBusinessAccess(request, tenantId, input.businessId, ["OWNER","ADMIN","STAFF"]);
    const business = await ensureBusiness(tenantId, input.businessId);
    const idem = request.headers["idempotency-key"] as string | undefined;
    const result = await idempotent(tenantId, "create_order", idem, async () => {
      return transaction(async (client) => {
        if (input.channelAccountId) {
          const channel = await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [input.channelAccountId, tenantId, input.businessId]);
          if (!channel.rows[0]) throw new ApiError(400, "CHANNEL_SCOPE_INVALID", "Channel does not belong to this business.");
        }
        for (const item of input.items) {
          if (item.collectionItemId) {
            const source = await client.query("SELECT id FROM collection_items WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND status='active'", [item.collectionItemId, tenantId, input.businessId]);
            if (!source.rows[0]) throw new ApiError(400, "ORDER_ITEM_INVALID", `Collection item ${item.collectionItemId} is unavailable.`);
          }
        }
        const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
        const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
        const order = await client.query<any>(`
          INSERT INTO orders(tenant_id,business_id,channel_account_id,conversation_id,contact_id,order_number,status,currency,subtotal,total,customer_snapshot,delivery_metadata,payment_metadata,source)
          VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12) RETURNING *
        `, [tenantId, input.businessId, input.channelAccountId ?? null, input.conversationId ?? null, input.contactId ?? null, orderNumber, input.currency ?? business.currency, subtotal, JSON.stringify(input.customer), JSON.stringify(input.delivery), JSON.stringify(input.payment), input.source]);
        for (const item of input.items) {
          await client.query(`INSERT INTO order_items(order_id,collection_item_id,title_snapshot,sku_snapshot,quantity,unit_price,total,attributes_snapshot)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [order.rows[0].id, item.collectionItemId ?? null, item.title, item.sku ?? null, item.quantity, item.unitPrice, item.quantity * item.unitPrice, JSON.stringify(item.attributes)]);
        }
        await client.query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,payload)
          VALUES ($1,'ORDER_CREATED',$2,'order',$3,$4::jsonb)`, [tenantId, input.businessId, order.rows[0].id, JSON.stringify({ orderNumber })]);
        return { order: order.rows[0] };
      });
    });
    await audit({ actorUserId: auth.userId, actorType: auth.internal ? "service" : "user", tenantId, businessId: input.businessId, action: "ORDER_CREATED", resourceType: "order", resourceId: (result as any).order.id, safeDiff: { itemCount: input.items.length, source: input.source }, request });
    reply.code(201).send(result);
  });

  app.patch("/v1/tenants/:tenantId/orders/:orderId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), orderId: z.string().uuid() }).parse(request.params);
    const auth = await internalOrTenant(request, params.tenantId);
    const targetOrder = await query<{ business_id: string }>("SELECT business_id FROM orders WHERE id=$1 AND tenant_id=$2", [params.orderId,params.tenantId]);
    if (!targetOrder.rows[0]) throw new ApiError(404,"ORDER_NOT_FOUND","Order not found.");
    if (!auth.internal) await requireBusinessAccess(request, params.tenantId, targetOrder.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const input = z.object({ status: z.string().min(1).max(60), delivery: z.record(z.string(), z.unknown()).optional(), payment: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const result = await query(`UPDATE orders SET status=$3,delivery_metadata=CASE WHEN $4::jsonb IS NULL THEN delivery_metadata ELSE delivery_metadata||$4::jsonb END,payment_metadata=CASE WHEN $5::jsonb IS NULL THEN payment_metadata ELSE payment_metadata||$5::jsonb END,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`, [params.orderId, params.tenantId, input.status, input.delivery ? JSON.stringify(input.delivery) : null, input.payment ? JSON.stringify(input.payment) : null]);
    if (!result.rows[0]) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
    await audit({ actorUserId: auth.userId, actorType: auth.internal ? "service" : "user", tenantId: params.tenantId, businessId: result.rows[0].business_id, action: "ORDER_UPDATED", resourceType: "order", resourceId: params.orderId, safeDiff: input, request });
    reply.send({ order: result.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/bookings", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const result = await query(`SELECT bk.*,ca.platform,ca.name AS channel_name FROM bookings bk LEFT JOIN channel_accounts ca ON ca.id=bk.channel_account_id WHERE bk.tenant_id=$1 AND ($2::uuid IS NULL OR bk.business_id=$2) AND ($3::timestamptz IS NULL OR bk.starts_at >= $3) AND ($4::timestamptz IS NULL OR bk.starts_at <= $4) AND ($5::uuid[] IS NULL OR bk.business_id=ANY($5::uuid[])) ORDER BY bk.starts_at DESC LIMIT $6`, [tenantId, q.businessId ?? null, q.from ?? null, q.to ?? null, scope, q.limit]);
    reply.send({ bookings: result.rows });
  });

  app.post("/v1/tenants/:tenantId/bookings", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const auth = await internalOrTenant(request, tenantId);
    const input = z.object({ businessId: z.string().uuid(), channelAccountId: z.string().uuid().nullable().optional(), conversationId: z.string().uuid().nullable().optional(), contactId: z.string().uuid().nullable().optional(), collectionItemId: z.string().uuid().nullable().optional(), startsAt: z.string().datetime(), endsAt: z.string().datetime().nullable().optional(), timezone: z.string().min(1).max(80), customer: z.record(z.string(), z.unknown()).default({}), metadata: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    await ensureBusiness(tenantId, input.businessId);
    const idem = request.headers["idempotency-key"] as string | undefined;
    const result = await idempotent(tenantId, "create_booking", idem, async () => {
      const row = await query<any>(`INSERT INTO bookings(tenant_id,business_id,channel_account_id,conversation_id,contact_id,collection_item_id,starts_at,ends_at,timezone,customer_snapshot,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) RETURNING *`, [tenantId, input.businessId, input.channelAccountId ?? null, input.conversationId ?? null, input.contactId ?? null, input.collectionItemId ?? null, input.startsAt, input.endsAt ?? null, input.timezone, JSON.stringify(input.customer), JSON.stringify(input.metadata)]);
      await query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,payload) VALUES ($1,'BOOKING_CREATED',$2,'booking',$3,$4::jsonb)`, [tenantId, input.businessId, row.rows[0].id, JSON.stringify({ startsAt: input.startsAt })]);
      return { booking: row.rows[0] };
    });
    await audit({ actorUserId: auth.userId, actorType: auth.internal ? "service" : "user", tenantId, businessId: input.businessId, action: "BOOKING_CREATED", resourceType: "booking", resourceId: (result as any).booking.id, request });
    reply.code(201).send(result);
  });

  app.patch("/v1/tenants/:tenantId/bookings/:bookingId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), bookingId: z.string().uuid() }).parse(request.params);
    const auth = await internalOrTenant(request, params.tenantId);
    const targetBooking = await query<{ business_id: string }>("SELECT business_id FROM bookings WHERE id=$1 AND tenant_id=$2", [params.bookingId,params.tenantId]);
    if (!targetBooking.rows[0]) throw new ApiError(404,"BOOKING_NOT_FOUND","Booking not found.");
    if (!auth.internal) await requireBusinessAccess(request, params.tenantId, targetBooking.rows[0].business_id, ["OWNER","ADMIN","STAFF"]);
    const input = z.object({ status: z.string().max(60).optional(), startsAt: z.string().datetime().optional(), endsAt: z.string().datetime().nullable().optional(), metadata: z.record(z.string(), z.unknown()).optional() }).parse(request.body);
    const row = await query(`UPDATE bookings SET status=COALESCE($3,status),starts_at=COALESCE($4,starts_at),ends_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE ends_at END,metadata=CASE WHEN $7::jsonb IS NULL THEN metadata ELSE metadata||$7::jsonb END,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`, [params.bookingId, params.tenantId, input.status ?? null, input.startsAt ?? null, Object.prototype.hasOwnProperty.call(input, "endsAt"), input.endsAt ?? null, input.metadata ? JSON.stringify(input.metadata) : null]);
    if (!row.rows[0]) throw new ApiError(404, "BOOKING_NOT_FOUND", "Booking not found.");
    await audit({ actorUserId: auth.userId, actorType: auth.internal ? "service" : "user", tenantId: params.tenantId, businessId: row.rows[0].business_id, action: "BOOKING_UPDATED", resourceType: "booking", resourceId: params.bookingId, safeDiff: input, request });
    reply.send({ booking: row.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/leads", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
    const q = z.object({ businessId: z.string().uuid().optional(), stage: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(request.query);
    const result = await query("SELECT * FROM leads WHERE tenant_id=$1 AND ($2::uuid IS NULL OR business_id=$2) AND ($3::text IS NULL OR stage=$3) AND ($4::uuid[] IS NULL OR business_id=ANY($4::uuid[])) ORDER BY created_at DESC LIMIT $5", [tenantId, q.businessId ?? null, q.stage ?? null, scope, q.limit]);
    reply.send({ leads: result.rows });
  });

  app.post("/v1/tenants/:tenantId/leads", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const auth = await internalOrTenant(request, tenantId);
    const input = z.object({ businessId: z.string().uuid(), channelAccountId: z.string().uuid().nullable().optional(), conversationId: z.string().uuid().nullable().optional(), contactId: z.string().uuid().nullable().optional(), interest: z.string().max(5000).optional(), stage: z.string().max(60).default("new"), metadata: z.record(z.string(), z.unknown()).default({}) }).parse(request.body);
    await ensureBusiness(tenantId, input.businessId);
    const idem = request.headers["idempotency-key"] as string | undefined;
    const result = await idempotent(tenantId, "create_lead", idem, async () => {
      const row = await query<any>("INSERT INTO leads(tenant_id,business_id,channel_account_id,conversation_id,contact_id,stage,interest,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *", [tenantId, input.businessId, input.channelAccountId ?? null, input.conversationId ?? null, input.contactId ?? null, input.stage, input.interest ?? null, JSON.stringify(input.metadata)]);
      return { lead: row.rows[0] };
    });
    await audit({ actorUserId: auth.userId, actorType: auth.internal ? "service" : "user", tenantId, businessId: input.businessId, action: "LEAD_CREATED", resourceType: "lead", resourceId: (result as any).lead.id, request });
    reply.code(201).send(result);
  });

  app.get("/v1/tenants/:tenantId/quotes", async (request, reply) => {
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const context=await requireTenant(request,tenantId);
    const scope=context.membershipRole==="OWNER"?null:context.businessScope??null;
    const q=z.object({businessId:z.string().uuid().optional(),status:z.string().max(60).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
    const result=await query("SELECT * FROM quote_requests WHERE tenant_id=$1 AND ($2::uuid IS NULL OR business_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::uuid[] IS NULL OR business_id=ANY($4::uuid[])) ORDER BY created_at DESC LIMIT $5",[tenantId,q.businessId??null,q.status??null,scope,q.limit]);
    reply.send({quotes:result.rows});
  });

  app.post("/v1/tenants/:tenantId/quotes", async (request, reply) => {
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const auth=await internalOrTenant(request,tenantId);
    const input=z.object({businessId:z.string().uuid(),channelAccountId:z.string().uuid().nullable().optional(),conversationId:z.string().uuid().nullable().optional(),contactId:z.string().uuid().nullable().optional(),request:z.record(z.string(),z.unknown()).default({})}).parse(request.body);
    if(!auth.internal) await requireBusinessAccess(request,tenantId,input.businessId,["OWNER","ADMIN","STAFF"]);
    await ensureBusiness(tenantId,input.businessId);
    const idem=request.headers["idempotency-key"] as string|undefined;
    const result=await idempotent(tenantId,"create_quote",idem,async()=> {
      const row=await query<any>("INSERT INTO quote_requests(tenant_id,business_id,channel_account_id,conversation_id,contact_id,request_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *",[tenantId,input.businessId,input.channelAccountId??null,input.conversationId??null,input.contactId??null,JSON.stringify(input.request)]);
      return {quote:row.rows[0]};
    });
    reply.code(201).send(result);
  });

  app.patch("/v1/tenants/:tenantId/quotes/:quoteId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),quoteId:z.string().uuid()}).parse(request.params);
    const auth=await internalOrTenant(request,params.tenantId);
    const target=await query<{business_id:string}>("SELECT business_id FROM quote_requests WHERE id=$1 AND tenant_id=$2",[params.quoteId,params.tenantId]);
    if(!target.rows[0]) throw new ApiError(404,"QUOTE_NOT_FOUND","Quote request not found.");
    if(!auth.internal) await requireBusinessAccess(request,params.tenantId,target.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
    const input=z.object({status:z.string().max(60).optional(),quote:z.record(z.string(),z.unknown()).optional(),assignedUserId:z.string().uuid().nullable().optional()}).parse(request.body);
    const row=await query<any>("UPDATE quote_requests SET status=COALESCE($3,status),quote_json=CASE WHEN $4::jsonb IS NULL THEN quote_json ELSE $4::jsonb END,assigned_user_id=CASE WHEN $5::boolean THEN $6::uuid ELSE assigned_user_id END,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",[params.quoteId,params.tenantId,input.status??null,input.quote?JSON.stringify(input.quote):null,Object.prototype.hasOwnProperty.call(input,"assignedUserId"),input.assignedUserId??null]);
    reply.send({quote:row.rows[0]});
  });

  app.get("/v1/tenants/:tenantId/support-cases", async (request, reply) => {
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const context=await requireTenant(request,tenantId);
    const scope=context.membershipRole==="OWNER"?null:context.businessScope??null;
    const q=z.object({businessId:z.string().uuid().optional(),status:z.string().max(60).optional(),priority:z.string().max(60).optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}).parse(request.query);
    const result=await query("SELECT * FROM support_cases WHERE tenant_id=$1 AND ($2::uuid IS NULL OR business_id=$2) AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR priority=$4) AND ($5::uuid[] IS NULL OR business_id=ANY($5::uuid[])) ORDER BY created_at DESC LIMIT $6",[tenantId,q.businessId??null,q.status??null,q.priority??null,scope,q.limit]);
    reply.send({cases:result.rows});
  });

  app.post("/v1/tenants/:tenantId/support-cases", async (request, reply) => {
    const {tenantId}=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const auth=await internalOrTenant(request,tenantId);
    const input=z.object({businessId:z.string().uuid(),channelAccountId:z.string().uuid().nullable().optional(),conversationId:z.string().uuid().nullable().optional(),contactId:z.string().uuid().nullable().optional(),subject:z.string().max(300).nullable().optional(),description:z.string().max(20000).nullable().optional(),priority:z.enum(["low","normal","high","urgent"]).default("normal"),metadata:z.record(z.string(),z.unknown()).default({})}).parse(request.body);
    if(!auth.internal) await requireBusinessAccess(request,tenantId,input.businessId,["OWNER","ADMIN","STAFF"]);
    await ensureBusiness(tenantId,input.businessId);
    const idem=request.headers["idempotency-key"] as string|undefined;
    const result=await idempotent(tenantId,"create_support_case",idem,async()=> {
      const row=await query<any>("INSERT INTO support_cases(tenant_id,business_id,channel_account_id,conversation_id,contact_id,subject,description,priority,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *",[tenantId,input.businessId,input.channelAccountId??null,input.conversationId??null,input.contactId??null,input.subject??null,input.description??null,input.priority,JSON.stringify(input.metadata)]);
      return {case:row.rows[0]};
    });
    reply.code(201).send(result);
  });

  app.patch("/v1/tenants/:tenantId/support-cases/:caseId", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),caseId:z.string().uuid()}).parse(request.params);
    const auth=await internalOrTenant(request,params.tenantId);
    const target=await query<{business_id:string}>("SELECT business_id FROM support_cases WHERE id=$1 AND tenant_id=$2",[params.caseId,params.tenantId]);
    if(!target.rows[0]) throw new ApiError(404,"SUPPORT_CASE_NOT_FOUND","Support case not found.");
    if(!auth.internal) await requireBusinessAccess(request,params.tenantId,target.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
    const input=z.object({status:z.string().max(60).optional(),priority:z.enum(["low","normal","high","urgent"]).optional(),assignedUserId:z.string().uuid().nullable().optional()}).parse(request.body);
    const row=await query<any>("UPDATE support_cases SET status=COALESCE($3,status),priority=COALESCE($4,priority),assigned_user_id=CASE WHEN $5::boolean THEN $6::uuid ELSE assigned_user_id END,updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *",[params.caseId,params.tenantId,input.status??null,input.priority??null,Object.prototype.hasOwnProperty.call(input,"assignedUserId"),input.assignedUserId??null]);
    reply.send({case:row.rows[0]});
  });
}
