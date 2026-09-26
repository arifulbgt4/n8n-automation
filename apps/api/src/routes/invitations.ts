import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  hashPassword,
  query,
  randomToken,
  sha256,
  transaction,
} from "@n8n-automation/core";
import {
  ApiError,
  audit,
  createSession,
  requireAuth,
  requireCsrf,
  requireTenant,
  sendEmail,
} from "../lib.js";

const passwordSchema = z.string().min(10).max(200).refine(
  (value) => /[A-Za-z]/.test(value) && /\d/.test(value),
  "Password must contain at least one letter and one number",
);

async function invitationByToken(token: string) {
  const result = await query<any>(`
    SELECT i.*,t.name AS tenant_name,t.slug AS tenant_slug
      FROM tenant_invitations i
      JOIN tenants t ON t.id=i.tenant_id
     WHERE i.token_hash=$1
       AND i.status='pending'
       AND i.expires_at>now()
       AND t.status='active'
     LIMIT 1
  `, [sha256(token)]);
  return result.rows[0] ?? null;
}

export async function invitationRoutes(app: FastifyInstance) {
  app.get("/v1/invitations/:token", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(500) }).parse(request.params);
    const invite = await invitationByToken(token);
    if (!invite) throw new ApiError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
    reply.send({
      invitation: {
        email: invite.email,
        role: invite.role,
        tenantName: invite.tenant_name,
        tenantSlug: invite.tenant_slug,
        expiresAt: invite.expires_at,
      },
    });
  });

  app.get("/v1/tenants/:tenantId/invitations", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    const result = await query(`
      SELECT id,email,role,business_scope,status,expires_at,accepted_at,created_at
        FROM tenant_invitations
       WHERE tenant_id=$1
         AND ($2::uuid[] IS NULL OR (business_scope IS NOT NULL AND business_scope && $2::uuid[]))
       ORDER BY created_at DESC
       LIMIT 200
    `, [tenantId, context.membershipRole === "OWNER" ? null : context.businessScope ?? null]);
    reply.send({ invitations: result.rows });
  });

  app.post("/v1/tenants/:tenantId/invitations", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      email: z.string().email().transform((v) => v.trim().toLowerCase()),
      role: z.enum(["ADMIN", "STAFF", "VIEWER"]),
      businessScope: z.array(z.string().uuid()).max(100).nullable().optional(),
      expiresInDays: z.number().int().min(1).max(30).default(7),
    }).parse(request.body);

    if (context.membershipRole !== "OWNER" && Array.isArray(context.businessScope) && (!context.businessScope.length || input.businessScope === undefined || input.businessScope === null || !input.businessScope.length || input.businessScope.some((businessId) => !context.businessScope?.includes(businessId)))) {
      throw new ApiError(403, "BUSINESS_SCOPE_ESCALATION", "An administrator cannot invite access outside their own business scope.");
    }
    if (input.businessScope?.length) {
      const scoped = await query<{ id: string }>(
        "SELECT id FROM businesses WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status<>'archived'",
        [tenantId, input.businessScope],
      );
      if (scoped.rowCount !== new Set(input.businessScope).size) {
        throw new ApiError(400, "BUSINESS_SCOPE_INVALID", "One or more selected businesses are invalid.");
      }
    }
    const member = await query("SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id WHERE tm.tenant_id=$1 AND lower(u.email)=lower($2)", [tenantId, input.email]);
    if (member.rowCount) throw new ApiError(409, "ALREADY_MEMBER", "This email is already a tenant member.");

    const token = randomToken(32);
    const created = await transaction(async (client) => {
      await client.query("UPDATE tenant_invitations SET status='revoked',updated_at=now() WHERE tenant_id=$1 AND lower(email)=lower($2) AND status='pending'", [tenantId, input.email]);
      const row = await client.query<any>(`
        INSERT INTO tenant_invitations(tenant_id,email,role,business_scope,token_hash,invited_by,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()+($7 || ' days')::interval)
        RETURNING id,email,role,business_scope,status,expires_at,created_at
      `, [tenantId,input.email,input.role,input.businessScope ?? null,sha256(token),principal.userId,String(input.expiresInDays)]);
      return row.rows[0];
    });

    const origin = process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:3000";
    const inviteUrl = `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
    await sendEmail(input.email, "You have been invited", `You have been invited to join a workspace. Accept the invitation: ${inviteUrl}`);
    await audit({ actorUserId: principal.userId, tenantId, action: "TENANT_INVITATION_CREATED", resourceType: "tenant_invitation", resourceId: created.id, safeDiff: { email: input.email, role: input.role, businessScope: input.businessScope ?? null }, request });
    reply.code(201).send({ invitation: created });
  });

  app.delete("/v1/tenants/:tenantId/invitations/:invitationId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), invitationId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const context = await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const result = await query(`
      UPDATE tenant_invitations
         SET status='revoked',updated_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='pending'
         AND ($3::uuid[] IS NULL OR (business_scope IS NOT NULL AND business_scope && $3::uuid[]))
       RETURNING id
    `, [params.invitationId, params.tenantId, context.membershipRole === "OWNER" ? null : context.businessScope ?? null]);
    if (!result.rows[0]) throw new ApiError(404, "INVITATION_NOT_FOUND", "Pending invitation not found.");
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, action: "TENANT_INVITATION_REVOKED", resourceType: "tenant_invitation", resourceId: params.invitationId, request });
    reply.send({ ok: true });
  });

  app.post("/v1/invitations/:token/accept", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(500) }).parse(request.params);
    const principal = await requireAuth(request);
    requireCsrf(request);
    const invite = await invitationByToken(token);
    if (!invite) throw new ApiError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
    if (principal.email.toLowerCase() !== String(invite.email).toLowerCase()) {
      throw new ApiError(403, "INVITATION_EMAIL_MISMATCH", "Sign in using the email address that received this invitation.");
    }
    await transaction(async (client) => {
      const locked = await client.query<any>("SELECT * FROM tenant_invitations WHERE id=$1 AND status='pending' AND expires_at>now() FOR UPDATE", [invite.id]);
      if (!locked.rows[0]) throw new ApiError(409, "INVITATION_ALREADY_USED", "Invitation is no longer available.");
      await client.query(`
        INSERT INTO tenant_memberships(tenant_id,user_id,role,status,business_scope,invited_by)
        VALUES ($1,$2,$3,'active',$4,$5)
        ON CONFLICT(tenant_id,user_id) DO UPDATE
        SET role=EXCLUDED.role,status='active',business_scope=EXCLUDED.business_scope,updated_at=now()
      `, [invite.tenant_id,principal.userId,invite.role,invite.business_scope,invite.invited_by]);
      await client.query("UPDATE tenant_invitations SET status='accepted',accepted_by=$2,accepted_at=now(),updated_at=now() WHERE id=$1", [invite.id,principal.userId]);
    });
    await audit({ actorUserId: principal.userId, tenantId: invite.tenant_id, action: "TENANT_INVITATION_ACCEPTED", resourceType: "tenant_invitation", resourceId: invite.id, request });
    reply.send({ ok: true, tenantId: invite.tenant_id });
  });

  app.post("/v1/invitations/:token/signup", async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(500) }).parse(request.params);
    const input = z.object({ name: z.string().trim().min(1).max(120), password: passwordSchema }).parse(request.body);
    const invite = await invitationByToken(token);
    if (!invite) throw new ApiError(404, "INVITATION_NOT_FOUND", "Invitation is invalid or expired.");
    const passwordHash = await hashPassword(input.password);
    const userId = await transaction(async (client) => {
      const locked = await client.query<any>("SELECT * FROM tenant_invitations WHERE id=$1 AND status='pending' AND expires_at>now() FOR UPDATE", [invite.id]);
      if (!locked.rows[0]) throw new ApiError(409, "INVITATION_ALREADY_USED", "Invitation is no longer available.");
      const existing = await client.query<{ id: string; status: string }>(
        "SELECT id,status FROM users WHERE lower(email)=lower($1) FOR UPDATE",
        [invite.email],
      );
      let userId: string;
      if (existing.rows[0]) {
        if (existing.rows[0].status !== "active") throw new ApiError(403, "ACCOUNT_UNAVAILABLE", "This account is not available.");
        const customerCredential = await client.query(
          "SELECT 1 FROM auth_credentials WHERE user_id=$1 AND realm='customer'",
          [existing.rows[0].id],
        );
        if (customerCredential.rowCount) throw new ApiError(409, "ACCOUNT_EXISTS", "A customer account already exists for this email. Sign in and accept the invitation.");
        userId = existing.rows[0].id;
        await client.query(`
          INSERT INTO auth_credentials(user_id,realm,email,password_hash)
          VALUES ($1,'customer',$2,$3)
        `, [userId, invite.email, passwordHash]);
        await client.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1", [userId]);
      } else {
        const user = await client.query<{ id: string }>(`
          INSERT INTO users(email,password_hash,name,status,email_verified_at)
          VALUES ($1,$2,$3,'active',now()) RETURNING id
        `, [invite.email,passwordHash,input.name]);
        userId = user.rows[0].id;
        await client.query(`
          INSERT INTO auth_credentials(user_id,realm,email,password_hash)
          VALUES ($1,'customer',$2,$3)
        `, [userId, invite.email, passwordHash]);
      }
      await client.query(`
        INSERT INTO tenant_memberships(tenant_id,user_id,role,status,business_scope,invited_by)
        VALUES ($1,$2,$3,'active',$4,$5)
      `, [invite.tenant_id,userId,invite.role,invite.business_scope,invite.invited_by]);
      await client.query("UPDATE tenant_invitations SET status='accepted',accepted_by=$2,accepted_at=now(),updated_at=now() WHERE id=$1", [invite.id,userId]);
      return userId;
    });
    const session = await createSession(userId, request, reply, { realm: "customer" });
    await audit({ actorUserId: userId, tenantId: invite.tenant_id, action: "INVITATION_SIGNUP_ACCEPTED", resourceType: "tenant_invitation", resourceId: invite.id, request });
    reply.code(201).send({ ok: true, tenantId: invite.tenant_id, csrfToken: session.csrfToken });
  });
}
