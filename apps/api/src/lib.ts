import type { FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import {
  env,
  query,
  randomToken,
  sha256,
  type MembershipRole,
  type SessionPrincipal,
} from "@n8n-automation/core";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type RequestContext = {
  principal: SessionPrincipal;
  tenantId?: string;
  membershipRole?: MembershipRole;
  businessScope?: string[] | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestContext;
    requestIdValue?: string;
  }
}

export function requestId(request: FastifyRequest): string {
  if (!request.requestIdValue) request.requestIdValue = String(request.id || randomToken(12));
  return request.requestIdValue;
}

export async function loadPrincipal(request: FastifyRequest): Promise<SessionPrincipal | null> {
  const token = request.cookies?.[env().SESSION_COOKIE_NAME];
  if (!token) return null;
  const result = await query<{
    session_id: string;
    csrf_token: string;
    user_id: string;
    email: string;
    name: string | null;
    email_verified_at: Date | null;
    platform_admin: boolean;
  }>(`
    SELECT s.id AS session_id, s.csrf_token, u.id AS user_id, u.email, u.name,
           u.email_verified_at,
           (pa.user_id IS NOT NULL AND pa.active=true) AS platform_admin
      FROM sessions s
      JOIN users u ON u.id=s.user_id
      LEFT JOIN platform_admins pa ON pa.user_id=u.id
     WHERE s.token_hash=$1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status='active'
  `, [sha256(token)]);
  const row = result.rows[0];
  if (!row) return null;
  await query("UPDATE sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]).catch(() => undefined);
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    platformAdmin: row.platform_admin,
    // Legacy fields remain in SessionPrincipal for schema/API compatibility, but MFA is disabled.
    platformAdminMfaRequired: false,
    platformAdminMfaEnabled: false,
    mfaVerifiedAt: null,
  };
}

export async function requireAuth(request: FastifyRequest): Promise<SessionPrincipal> {
  const principal = await loadPrincipal(request);
  if (!principal) throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required.");
  request.auth = { principal };
  return principal;
}

export async function requirePlatformAdmin(request: FastifyRequest): Promise<SessionPrincipal> {
  const principal = await requireAuth(request);
  if (!principal.platformAdmin) throw new ApiError(403, "ADMIN_REQUIRED", "Platform administrator access is required.");
  return principal;
}

// Kept as a compatibility alias for privileged routes. Password-authenticated
// Super Admin sessions are sufficient; there is no secondary MFA re-auth gate.
export async function requireRecentPlatformAdmin(request: FastifyRequest, _maxAgeMinutes = 15): Promise<SessionPrincipal> {
  return requirePlatformAdmin(request);
}

export async function requireTenant(
  request: FastifyRequest,
  tenantId: string,
  allowedRoles: MembershipRole[] = ["OWNER", "ADMIN", "STAFF", "VIEWER"],
): Promise<RequestContext> {
  const principal = request.auth?.principal ?? await requireAuth(request);
  if (principal.platformAdmin && request.headers["x-admin-tenant-access"] === "support") {
    request.auth = { principal, tenantId, membershipRole: "OWNER", businessScope: null };
    return request.auth;
  }
  const membership = await query<{ role: MembershipRole; status: string; business_scope: string[] | null }>(
    "SELECT role, status, business_scope FROM tenant_memberships WHERE tenant_id=$1 AND user_id=$2",
    [tenantId, principal.userId],
  );
  const row = membership.rows[0];
  if (!row || row.status !== "active" || !allowedRoles.includes(row.role)) {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found.");
  }
  request.auth = { principal, tenantId, membershipRole: row.role, businessScope: row.business_scope };
  return request.auth;
}

export async function requireBusinessAccess(
  request: FastifyRequest,
  tenantId: string,
  businessId: string,
  allowedRoles: MembershipRole[] = ["OWNER", "ADMIN", "STAFF", "VIEWER"],
): Promise<RequestContext> {
  const context = request.auth?.tenantId === tenantId
    ? request.auth
    : await requireTenant(request, tenantId, allowedRoles);
  if (!context.membershipRole || !allowedRoles.includes(context.membershipRole)) {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found.");
  }
  if (context.membershipRole !== "OWNER" && Array.isArray(context.businessScope) && !context.businessScope.includes(businessId)) {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "Resource not found.");
  }
  const exists = await query("SELECT 1 FROM businesses WHERE id=$1 AND tenant_id=$2 AND status<>'archived'", [businessId,tenantId]);
  if (!exists.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
  return context;
}

export function requireCsrf(request: FastifyRequest): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const principal = request.auth?.principal;
  if (!principal) throw new ApiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const headerName = env().CSRF_HEADER_NAME.toLowerCase();
  const supplied = request.headers[headerName] as string | undefined;
  if (!supplied || sha256(supplied) !== principal.csrfToken) {
    throw new ApiError(403, "CSRF_INVALID", "CSRF token is missing or invalid.");
  }
}

export async function createSession(
  userId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ csrfToken: string }> {
  const token = randomToken(32);
  const csrfRaw = randomToken(24);
  const csrfHash = sha256(csrfRaw);
  const days = env().SESSION_TTL_DAYS;
  await query(`
    INSERT INTO sessions(user_id, token_hash, csrf_token, ip, user_agent, expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+($6 || ' days')::interval)
  `, [userId, sha256(token), csrfHash, request.ip || null, request.headers["user-agent"] || null, String(days)]);
  reply.setCookie("n8nauto_csrf", csrfRaw, {
    httpOnly: false,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: days * 24 * 60 * 60,
  });
  reply.setCookie(env().SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: days * 24 * 60 * 60,
  });
  return { csrfToken: csrfRaw };
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(env().SESSION_COOKIE_NAME, { path: "/" });
  reply.clearCookie("n8nauto_csrf", { path: "/" });
}

export async function audit(input: {
  actorUserId?: string | null;
  actorType?: string;
  tenantId?: string | null;
  businessId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  safeDiff?: Record<string, unknown>;
  request?: FastifyRequest;
  client?: pg.PoolClient;
}): Promise<void> {
  const executor = input.client ?? { query: (text: string, values: unknown[]) => query(text, values) };
  await executor.query(`
    INSERT INTO audit_logs(actor_user_id,actor_type,tenant_id,business_id,action,resource_type,resource_id,safe_diff,ip,user_agent,correlation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [
    input.actorUserId ?? null,
    input.actorType ?? "user",
    input.tenantId ?? null,
    input.businessId ?? null,
    input.action,
    input.resourceType,
    input.resourceId ?? null,
    input.safeDiff ?? {},
    input.request?.ip ?? null,
    input.request?.headers["user-agent"] ?? null,
    input.request ? requestId(input.request) : null,
  ]);
}

export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  const hook = env().EMAIL_DELIVERY_WEBHOOK_URL;
  if (!hook) {
    if (env().NODE_ENV !== "production") console.info("EMAIL_DELIVERY_WEBHOOK_URL not configured", { to, subject, text });
    return;
  }
  const response = await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: env().EMAIL_FROM, to, subject, text }),
  });
  if (!response.ok) throw new Error(`Email delivery webhook failed: ${response.status}`);
}

export function jsonError(error: ApiError, request: FastifyRequest) {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? {},
      requestId: requestId(request),
    },
  };
}

export function slugify(value: string): string {
  const base = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return base || `tenant-${randomToken(5).toLowerCase()}`;
}
