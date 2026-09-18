import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireCsrf, requireTenant, slugify } from "../lib.js";
import { assertTenantCountLimit } from "../limits.js";

const tenantRoles = ["OWNER", "ADMIN", "STAFF", "VIEWER"] as const;

export async function tenantRoutes(app: FastifyInstance) {
  app.get("/v1/tenants", async (request, reply) => {
    const principal = await requireAuth(request);
    const result = await query(`
      SELECT t.id,t.name,t.slug,t.status,t.plan_id,t.settings_json,t.created_at,tm.role
      FROM tenants t
      JOIN tenant_memberships tm ON tm.tenant_id=t.id
      WHERE tm.user_id=$1 AND tm.status='active' AND t.status <> 'deleted'
      ORDER BY t.created_at
    `, [principal.userId]);
    reply.send({ tenants: result.rows });
  });

  app.get("/v1/tenants/:tenantId", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    const tenant = await query(`
      SELECT t.*, p.key AS plan_key, p.name AS plan_name, p.features AS plan_features, p.limits AS plan_limits
      FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1
    `, [tenantId]);
    if (!tenant.rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
    reply.send({ tenant: tenant.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    const result = await query(`
      UPDATE tenants
         SET name=COALESCE($2,name),
             settings_json=CASE WHEN $3::jsonb IS NULL THEN settings_json ELSE settings_json || $3::jsonb END,
             updated_at=now()
       WHERE id=$1
       RETURNING *
    `, [tenantId, input.name ?? null, input.settings ? JSON.stringify(input.settings) : null]);
    await audit({ actorUserId: principal.userId, tenantId, action: "TENANT_UPDATED", resourceType: "tenant", resourceId: tenantId, safeDiff: input, request });
    reply.send({ tenant: result.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/members", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    const result = await query(`
      SELECT tm.user_id,tm.role,tm.status,tm.business_scope,tm.created_at,u.email,u.name,u.last_login_at
      FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
      WHERE tm.tenant_id=$1 ORDER BY tm.created_at
    `, [tenantId]);
    reply.send({ members: result.rows });
  });

  app.patch("/v1/tenants/:tenantId/members/:userId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      role: z.enum(tenantRoles).optional(),
      status: z.enum(["active", "suspended"]).optional(),
      businessScope: z.array(z.string().uuid()).nullable().optional(),
    }).parse(request.body);
    if (params.userId === principal.userId && input.status === "suspended") throw new ApiError(400, "SELF_SUSPEND_FORBIDDEN", "You cannot suspend your own membership.");
    const result = await query(`
      UPDATE tenant_memberships
         SET role=COALESCE($3,role),status=COALESCE($4,status),business_scope=COALESCE($5::uuid[],business_scope),updated_at=now()
       WHERE tenant_id=$1 AND user_id=$2
       RETURNING *
    `, [params.tenantId, params.userId, input.role ?? null, input.status ?? null, input.businessScope ?? null]);
    if (!result.rows[0]) throw new ApiError(404, "MEMBER_NOT_FOUND", "Member not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, action: "MEMBER_UPDATED", resourceType: "tenant_membership", resourceId: params.userId, safeDiff: input, request });
    reply.send({ member: result.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/businesses", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, tenantId);
    const result = await query(`
      SELECT b.*,
        (SELECT count(*)::int FROM channel_accounts c WHERE c.business_id=b.id AND c.active=true) AS channel_count,
        (SELECT count(*)::int FROM collections col WHERE col.business_id=b.id AND col.status='active') AS collection_count
      FROM businesses b
      WHERE b.tenant_id=$1 AND b.status <> 'archived'
      ORDER BY b.created_at
    `, [tenantId]);
    reply.send({ businesses: result.rows });
  });

  app.post("/v1/tenants/:tenantId/businesses", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    await assertTenantCountLimit(tenantId, "businesses", "SELECT count(*) FROM businesses WHERE tenant_id=$1 AND status<>'archived'");
    const input = z.object({
      name: z.string().trim().min(1).max(160),
      businessTypeHint: z.string().trim().max(80).optional(),
      timezone: z.string().trim().min(1).max(80).default("UTC"),
      currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
      locale: z.string().trim().min(2).max(20).default("en"),
      settings: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    let slug = slugify(input.name);
    const collision = await query("SELECT 1 FROM businesses WHERE tenant_id=$1 AND slug=$2", [tenantId, slug]);
    if (collision.rowCount) slug = `${slug}-${Date.now().toString(36)}`;
    const result = await query(`
      INSERT INTO businesses(tenant_id,name,slug,business_type_hint,timezone,currency,locale,settings_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      RETURNING *
    `, [tenantId, input.name, slug, input.businessTypeHint ?? null, input.timezone, input.currency, input.locale, JSON.stringify(input.settings)]);
    await audit({ actorUserId: principal.userId, tenantId, businessId: result.rows[0].id, action: "BUSINESS_CREATED", resourceType: "business", resourceId: result.rows[0].id, safeDiff: { name: input.name }, request });
    reply.code(201).send({ business: result.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/businesses/:businessId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), businessId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const result = await query("SELECT * FROM businesses WHERE id=$1 AND tenant_id=$2", [params.businessId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    reply.send({ business: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/businesses/:businessId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), businessId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      timezone: z.string().trim().min(1).max(80).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      locale: z.string().trim().min(2).max(20).optional(),
      status: z.enum(["active", "paused", "archived"]).optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    const result = await query(`
      UPDATE businesses SET
        name=COALESCE($3,name),timezone=COALESCE($4,timezone),currency=COALESCE($5,currency),
        locale=COALESCE($6,locale),status=COALESCE($7,status),
        settings_json=CASE WHEN $8::jsonb IS NULL THEN settings_json ELSE settings_json || $8::jsonb END,
        updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *
    `, [params.businessId, params.tenantId, input.name ?? null, input.timezone ?? null, input.currency ?? null, input.locale ?? null, input.status ?? null, input.settings ? JSON.stringify(input.settings) : null]);
    if (!result.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: params.businessId, action: "BUSINESS_UPDATED", resourceType: "business", resourceId: params.businessId, safeDiff: input, request });
    reply.send({ business: result.rows[0] });
  });

  app.post("/v1/tenants/:tenantId/businesses/:businessId/archive", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), businessId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER"]);
    requireCsrf(request);
    await transaction(async (client) => {
      const business = await client.query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [params.businessId, params.tenantId]);
      if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
      await client.query("UPDATE businesses SET status='archived',updated_at=now() WHERE id=$1", [params.businessId]);
      await client.query("UPDATE channel_accounts SET active=false,updated_at=now() WHERE business_id=$1", [params.businessId]);
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: params.businessId, action: "BUSINESS_ARCHIVED", resourceType: "business", resourceId: params.businessId, request });
    reply.send({ ok: true });
  });
}
