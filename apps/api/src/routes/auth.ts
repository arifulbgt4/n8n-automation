import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  hashPassword,
  query,
  randomToken,
  redis,
  redisKey,
  sha256,
  transaction,
  verifyPassword,
} from "@n8n-automation/core";
import {
  ApiError,
  audit,
  clearSessionCookie,
  createSession,
  loadPrincipal,
  requireAuth,
  requireCsrf,
  sendEmail,
  slugify,
} from "../lib.js";

async function authRateLimit(key: string, limit: number, ttlSeconds: number) {
  const redisKeyValue = redisKey("auth",key);
  const count = await redis().incr(redisKeyValue);
  if (count === 1) await redis().expire(redisKeyValue,ttlSeconds);
  if (count > limit) throw new ApiError(429,"AUTH_RATE_LIMITED","Too many authentication attempts. Try again later.",{retryAfterSeconds:await redis().ttl(redisKeyValue)});
}

const passwordSchema = z.string().min(10).max(200).refine(
  (value) => /[A-Za-z]/.test(value) && /\d/.test(value),
  "Password must contain at least one letter and one number",
);

export async function authRoutes(app: FastifyInstance) {
  app.post("/v1/auth/signup", async (request, reply) => {
    await authRateLimit(`signup:ip:${request.ip}`,10,3600);
    const input = z.object({
      email: z.string().email().transform((v) => v.trim().toLowerCase()),
      password: passwordSchema,
      name: z.string().trim().min(1).max(120),
      organizationName: z.string().trim().min(1).max(160),
    }).parse(request.body);
    await authRateLimit(`signup:email:${sha256(input.email)}`,5,3600);

    const token = randomToken(32);
    const passwordHash = await hashPassword(input.password);
    const { userId, tenantId } = await transaction(async (client) => {
      const existing = await client.query<{ id: string; status: string }>(
        "SELECT id,status FROM users WHERE email=$1 FOR UPDATE",
        [input.email],
      );
      let userId: string;
      if (existing.rows[0]) {
        if (existing.rows[0].status !== "active") {
          throw new ApiError(403, "ACCOUNT_UNAVAILABLE", "This account is not available for customer sign-in.");
        }
        const customerCredential = await client.query(
          "SELECT 1 FROM auth_credentials WHERE user_id=$1 AND realm='customer'",
          [existing.rows[0].id],
        );
        if (customerCredential.rowCount) throw new ApiError(409, "EMAIL_EXISTS", "An account already exists for this email.");
        userId = existing.rows[0].id;
        await client.query(`
          INSERT INTO auth_credentials(user_id,realm,email,password_hash)
          VALUES ($1,'customer',$2,$3)
        `, [userId, input.email, passwordHash]);
      } else {
        const user = await client.query<{ id: string }>(`
          INSERT INTO users(email,password_hash,name)
          VALUES ($1,$2,$3)
          RETURNING id
        `, [input.email, passwordHash, input.name]);
        userId = user.rows[0].id;
        await client.query(`
          INSERT INTO auth_credentials(user_id,realm,email,password_hash)
          VALUES ($1,'customer',$2,$3)
        `, [userId, input.email, passwordHash]);
      }
      let slug = slugify(input.organizationName);
      const collision = await client.query("SELECT 1 FROM tenants WHERE slug=$1", [slug]);
      if (collision.rowCount) slug = `${slug}-${randomToken(4).toLowerCase()}`;
      const plan = await client.query<{ id: string }>("SELECT id FROM plans WHERE key='starter' LIMIT 1");
      const tenant = await client.query<{ id: string }>(`
        INSERT INTO tenants(name,slug,plan_id)
        VALUES ($1,$2,$3)
        RETURNING id
      `, [input.organizationName, slug, plan.rows[0]?.id ?? null]);
      await client.query(`
        INSERT INTO tenant_memberships(tenant_id,user_id,role,status)
        VALUES ($1,$2,'OWNER','active')
      `, [tenant.rows[0].id, userId]);
      await client.query(`
        INSERT INTO email_verification_tokens(user_id,token_hash,expires_at)
        VALUES ($1,$2,now()+interval '24 hours')
      `, [userId, sha256(token)]);
      await client.query(`
        INSERT INTO audit_logs(actor_user_id,tenant_id,action,resource_type,resource_id,safe_diff,ip,user_agent)
        VALUES ($1,$2,'AUTH_SIGNUP','user',$6,$3,$4,$5)
      `, [
        userId,
        tenant.rows[0].id,
        { email: input.email },
        request.ip,
        request.headers["user-agent"] ?? null,
        userId,
      ]);
      return { userId, tenantId: tenant.rows[0].id };
    });

    const verifyUrl = `${process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:3000"}/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmail(input.email, "Verify your account", `Verify your account: ${verifyUrl}`);
    const session = await createSession(userId, request, reply, { realm: "customer" });
    reply.code(201).send({
      user: { id: userId, email: input.email, name: input.name, emailVerified: false },
      tenantId,
      csrfToken: session.csrfToken,
    });
  });

  app.post("/v1/auth/signin", async (request, reply) => {
    await authRateLimit(`signin:ip:${request.ip}`,40,900);
    const input = z.object({
      email: z.string().email().transform((v) => v.trim().toLowerCase()),
      password: z.string().min(1).max(200),
      realm: z.enum(["customer", "admin"]).default("customer"),
    }).parse(request.body);
    const emailLimitKey=`signin:${input.realm}:email:${sha256(input.email)}`;
    await authRateLimit(emailLimitKey,12,900);
    const result = await query<{
      id: string;
      email: string;
      password_hash: string;
      name: string | null;
      status: string;
      email_verified_at: Date | null;
      admin_active: boolean;
      admin_mfa_required: boolean;
      admin_mfa_enabled: boolean;
    }>(`
      SELECT u.id,u.email,c.password_hash,u.name,u.status,u.email_verified_at,
             COALESCE(pa.active,false) AS admin_active,
             COALESCE(pa.mfa_required,false) AS admin_mfa_required,
             COALESCE(pa.mfa_enabled,false) AS admin_mfa_enabled
      FROM auth_credentials c
      JOIN users u ON u.id=c.user_id
      LEFT JOIN platform_admins pa ON pa.user_id=u.id
      WHERE c.email=$1 AND c.realm=$2
    `, [input.email, input.realm]);
    const user = result.rows[0];
    const valid = user ? await verifyPassword(input.password, user.password_hash) : false;
    if (!user || !valid || user.status !== "active" || (input.realm === "admin" && !user.admin_active)) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    await redis().del(redisKey("auth",emailLimitKey)).catch(()=>undefined);
    await query("UPDATE users SET last_login_at=now(), updated_at=now() WHERE id=$1", [user.id]);

    if (input.realm === "admin" && user.admin_active && user.admin_mfa_required && user.admin_mfa_enabled) {
      const challengeToken = randomToken(32);
      await query(`
        INSERT INTO admin_mfa_challenges(user_id,token_hash,expires_at,ip,user_agent)
        VALUES ($1,$2,now()+interval '5 minutes',$3,$4)
      `, [user.id, sha256(challengeToken), request.ip ?? null, request.headers["user-agent"] ?? null]);
      await audit({ actorUserId: user.id, actorType: "platform_admin", action: "ADMIN_PASSWORD_VERIFIED_MFA_PENDING", resourceType: "user", resourceId: user.id, request });
      return reply.send({
        mfaRequired: true,
        challengeToken,
        user: { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.email_verified_at), platformAdmin: true },
      });
    }

    const session = await createSession(user.id, request, reply, { realm: input.realm });
    await audit({ actorUserId: user.id, actorType: input.realm === "admin" ? "platform_admin" : "user", action: "AUTH_SIGNIN", resourceType: "user", resourceId: user.id, request });
    reply.send({
      user: { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.email_verified_at), platformAdmin: input.realm === "admin" && user.admin_active },
      csrfToken: session.csrfToken,
      mfaSetupRequired: Boolean(input.realm === "admin" && user.admin_active && user.admin_mfa_required && !user.admin_mfa_enabled),
    });
  });

  app.post("/v1/auth/signout", async (request, reply) => {
    const principal = await requireAuth(request);
    requireCsrf(request);
    await query("UPDATE sessions SET revoked_at=now() WHERE id=$1", [principal.sessionId]);
    clearSessionCookie(reply);
    await audit({ actorUserId: principal.userId, action: "AUTH_SIGNOUT", resourceType: "session", resourceId: principal.sessionId, request });
    reply.send({ ok: true });
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const principal = await loadPrincipal(request);
    if (!principal) return reply.code(401).send({ error: { code: "AUTH_REQUIRED", message: "Authentication is required." } });
    const memberships = await query(`
      SELECT tm.tenant_id, tm.role, tm.status, t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status
      FROM tenant_memberships tm
      JOIN tenants t ON t.id=tm.tenant_id
      WHERE tm.user_id=$1
      ORDER BY t.created_at
    `, [principal.userId]);
    const { csrfToken: _csrfHash, ...safePrincipal } = principal;
    reply.send({ principal: safePrincipal, memberships: memberships.rows });
  });

  app.post("/v1/auth/verify-email", async (request, reply) => {
    const input = z.object({ token: z.string().min(20) }).parse(request.body);
    const result = await transaction(async (client) => {
      const token = await client.query<{ id: string; user_id: string }>(`
        SELECT id,user_id FROM email_verification_tokens
        WHERE token_hash=$1 AND auth_realm='customer' AND used_at IS NULL AND expires_at>now()
        FOR UPDATE
      `, [sha256(input.token)]);
      if (!token.rows[0]) throw new ApiError(400, "VERIFY_TOKEN_INVALID", "Verification token is invalid or expired.");
      await client.query("UPDATE users SET email_verified_at=COALESCE(email_verified_at,now()),updated_at=now() WHERE id=$1", [token.rows[0].user_id]);
      await client.query("UPDATE email_verification_tokens SET used_at=now() WHERE id=$1", [token.rows[0].id]);
      return token.rows[0].user_id;
    });
    reply.send({ ok: true, userId: result });
  });

  app.post("/v1/auth/resend-verification", async (request, reply) => {
    const principal = await requireAuth(request);
    if (principal.authRealm !== "customer") throw new ApiError(403, "CUSTOMER_SESSION_REQUIRED", "Use the Customer Panel for customer account verification.");
    requireCsrf(request);
    if (principal.emailVerifiedAt) return reply.send({ ok: true });
    const token = randomToken(32);
    await query(`
      INSERT INTO email_verification_tokens(user_id,token_hash,expires_at)
      VALUES ($1,$2,now()+interval '24 hours')
    `, [principal.userId, sha256(token)]);
    const verifyUrl = `${process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:3000"}/verify-email?token=${encodeURIComponent(token)}`;
    await sendEmail(principal.email, "Verify your account", `Verify your account: ${verifyUrl}`);
    reply.send({ ok: true });
  });

  app.post("/v1/auth/request-password-reset", async (request, reply) => {
    await authRateLimit(`reset:ip:${request.ip}`,20,3600);
    const input = z.object({
      email: z.string().email().transform((v) => v.trim().toLowerCase()),
      realm: z.literal("customer").default("customer"),
    }).parse(request.body);
    await authRateLimit(`reset:${input.realm}:email:${sha256(input.email)}`,5,3600);
    const user = await query<{ id: string }>(`
      SELECT c.user_id AS id
        FROM auth_credentials c
        JOIN users u ON u.id=c.user_id
       WHERE c.email=$1 AND c.realm=$2 AND u.status='active'
    `, [input.email, input.realm]);
    if (user.rows[0]) {
      const token = randomToken(32);
      await query(`
        INSERT INTO password_reset_tokens(user_id,auth_realm,token_hash,expires_at)
        VALUES ($1,$2,$3,now()+interval '1 hour')
      `, [user.rows[0].id, input.realm, sha256(token)]);
      const url = `${process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:3000"}/reset-password?token=${encodeURIComponent(token)}`;
      await sendEmail(input.email, "Reset your password", `Reset your password: ${url}`);
    }
    reply.send({ ok: true });
  });

  app.post("/v1/auth/reset-password", async (request, reply) => {
    const input = z.object({ token: z.string().min(20), password: passwordSchema }).parse(request.body);
    const passwordHash = await hashPassword(input.password);
    await transaction(async (client) => {
      const token = await client.query<{ id: string; user_id: string; auth_realm: "customer" | "admin" }>(`
        SELECT id,user_id,auth_realm FROM password_reset_tokens
        WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()
        FOR UPDATE
      `, [sha256(input.token)]);
      if (!token.rows[0]) throw new ApiError(400, "RESET_TOKEN_INVALID", "Reset token is invalid or expired.");
      const credential = await client.query(
        "UPDATE auth_credentials SET password_hash=$3,updated_at=now() WHERE user_id=$1 AND realm=$2 RETURNING id",
        [token.rows[0].user_id, token.rows[0].auth_realm, passwordHash],
      );
      if (!credential.rows[0]) throw new ApiError(400, "RESET_TOKEN_INVALID", "Reset token is invalid or expired.");
      await client.query("UPDATE users SET updated_at=now() WHERE id=$1", [token.rows[0].user_id]);
      await client.query("UPDATE password_reset_tokens SET used_at=now() WHERE id=$1", [token.rows[0].id]);
      await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND auth_realm=$2 AND revoked_at IS NULL", [token.rows[0].user_id, token.rows[0].auth_realm]);
    });
    clearSessionCookie(reply);
    reply.send({ ok: true });
  });
  app.post("/v1/auth/change-password", async (request, reply) => {
    const principal=await requireAuth(request);
    requireCsrf(request);
    const input=z.object({currentPassword:z.string().min(1).max(200),newPassword:passwordSchema}).parse(request.body);
    const user=await query<{password_hash:string}>("SELECT password_hash FROM auth_credentials WHERE user_id=$1 AND realm=$2",[principal.userId,principal.authRealm]);
    if(!user.rows[0] || !(await verifyPassword(input.currentPassword,user.rows[0].password_hash))) {
      throw new ApiError(403,"CURRENT_PASSWORD_INVALID","Current password is incorrect.");
    }
    const passwordHash=await hashPassword(input.newPassword);
    await transaction(async(client)=>{
      await client.query("UPDATE auth_credentials SET password_hash=$3,updated_at=now() WHERE user_id=$1 AND realm=$2",[principal.userId,principal.authRealm,passwordHash]);
      await client.query("UPDATE users SET updated_at=now() WHERE id=$1",[principal.userId]);
      await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND auth_realm=$2 AND id<>$3 AND revoked_at IS NULL",[principal.userId,principal.authRealm,principal.sessionId]);
    });
    await audit({actorUserId:principal.userId,action:"PASSWORD_CHANGED",resourceType:"user",resourceId:principal.userId,request});
    reply.send({ok:true});
  });

}
