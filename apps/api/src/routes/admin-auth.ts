import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  query,
  randomToken,
  redis,
  redisKey,
  sha256,
  transaction,
  type PlatformAdminRole,
} from "@n8n-automation/core";
import { generateTotpSecret, otpAuthUri, verifyTotp } from "../mfa.js";
import { ApiError, audit, createSession, requireCsrf, requirePlatformAdmin, requireRecentPlatformAdmin } from "../lib.js";

const platformAdminRoles: PlatformAdminRole[] = ["SUPER_ADMIN", "SUPPORT_ADMIN", "BILLING_ADMIN", "OPS_ADMIN", "READONLY_ADMIN"];

async function mfaRateLimit(key: string, limit = 8, ttlSeconds = 300): Promise<void> {
  const counterKey = redisKey("admin-mfa", key);
  const count = await redis().incr(counterKey);
  if (count === 1) await redis().expire(counterKey, ttlSeconds);
  if (count > limit) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many MFA attempts. Try again later.", { retryAfterSeconds: await redis().ttl(counterKey) });
  }
}

function recoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => `${randomToken(5).slice(0, 5)}-${randomToken(5).slice(0, 5)}`.toUpperCase());
}

async function verifyCode(row: any, code: string): Promise<{ valid: boolean; recoveryHash: string | null }> {
  if (row.mfa_secret_encrypted && verifyTotp(decryptSecret(row.mfa_secret_encrypted), code)) {
    return { valid: true, recoveryHash: null };
  }
  const recoveryHash = sha256(code.toUpperCase().trim());
  return {
    valid: Array.isArray(row.recovery_code_hashes) && row.recovery_code_hashes.includes(recoveryHash),
    recoveryHash,
  };
}

export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/admin/auth/mfa", async (request, reply) => {
    const input = z.object({ challengeToken: z.string().min(20), code: z.string().min(6).max(30) }).parse(request.body);
    await mfaRateLimit(`challenge:${request.ip}:${sha256(input.challengeToken)}`);
    const challenge = await query<any>(`
      SELECT c.id,c.user_id,pa.mfa_secret_encrypted,pa.recovery_code_hashes,u.email,u.name,u.status
      FROM admin_mfa_challenges c
      JOIN platform_admins pa ON pa.user_id=c.user_id AND pa.active=true AND pa.mfa_enabled=true
      JOIN users u ON u.id=c.user_id
      WHERE c.token_hash=$1 AND c.used_at IS NULL AND c.expires_at>now()
    `, [sha256(input.challengeToken)]);
    const row = challenge.rows[0];
    if (!row || row.status !== "active" || !row.mfa_secret_encrypted) throw new ApiError(401, "MFA_CHALLENGE_INVALID", "MFA challenge is invalid or expired.");
    const result = await verifyCode(row, input.code);
    if (!result.valid) throw new ApiError(401, "MFA_CODE_INVALID", "MFA code is invalid.");

    const session = await transaction(async (client) => {
      const claimed = await client.query("UPDATE admin_mfa_challenges SET used_at=now() WHERE id=$1 AND used_at IS NULL RETURNING id", [row.id]);
      if (!claimed.rows[0]) throw new ApiError(401, "MFA_CHALLENGE_INVALID", "MFA challenge is invalid or expired.");
      if (result.recoveryHash) {
        await client.query("UPDATE platform_admins SET recovery_code_hashes=array_remove(recovery_code_hashes,$2),updated_at=now() WHERE user_id=$1", [row.user_id, result.recoveryHash]);
      }
      return createSession(row.user_id, request, reply, { mfaVerified: true, client });
    });
    await audit({ actorUserId: row.user_id, actorType: "platform_admin", action: "ADMIN_MFA_SIGNIN", resourceType: "user", resourceId: row.user_id, request });
    reply.send({ ok: true, csrfToken: session.csrfToken, user: { id: row.user_id, email: row.email, name: row.name, platformAdmin: true } });
  });

  app.get("/v1/admin/mfa/status", async (request, reply) => {
    const principal = await requirePlatformAdmin(request, { allowMfaSetup: true, roles: platformAdminRoles });
    const result = await query<any>("SELECT mfa_required,mfa_enabled,cardinality(recovery_code_hashes) AS recovery_codes_remaining FROM platform_admins WHERE user_id=$1", [principal.userId]);
    reply.send({ ...result.rows[0], sessionMfaVerified: Boolean(principal.mfaVerifiedAt) });
  });

  app.post("/v1/admin/mfa/setup", async (request, reply) => {
    const principal = await requirePlatformAdmin(request, { allowMfaSetup: true, roles: platformAdminRoles });
    requireCsrf(request);
    const current = await query<{ mfa_enabled: boolean }>("SELECT mfa_enabled FROM platform_admins WHERE user_id=$1 AND active=true", [principal.userId]);
    if (current.rows[0]?.mfa_enabled) {
      await requireRecentPlatformAdmin(request, { roles: platformAdminRoles });
    }
    const secret = generateTotpSecret();
    await query("UPDATE platform_admins SET mfa_secret_encrypted=$2,mfa_enabled=false,recovery_code_hashes='{}',updated_at=now() WHERE user_id=$1", [principal.userId, encryptSecret(secret)]);
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "ADMIN_MFA_SETUP_STARTED", resourceType: "user", resourceId: principal.userId, request });
    reply.send({ secret, otpauthUri: otpAuthUri(principal.email, "n8n Automation SaaS", secret) });
  });

  app.post("/v1/admin/mfa/confirm", async (request, reply) => {
    const principal = await requirePlatformAdmin(request, { allowMfaSetup: true, roles: platformAdminRoles });
    requireCsrf(request);
    const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(request.body);
    await mfaRateLimit(`setup:${principal.userId}:${principal.sessionId}`);
    const admin = await query<{ mfa_secret_encrypted: string | null }>("SELECT mfa_secret_encrypted FROM platform_admins WHERE user_id=$1", [principal.userId]);
    if (!admin.rows[0]?.mfa_secret_encrypted) throw new ApiError(400, "MFA_SETUP_NOT_STARTED", "Start MFA setup first.");
    if (!verifyTotp(decryptSecret(admin.rows[0].mfa_secret_encrypted), input.code)) throw new ApiError(400, "MFA_CODE_INVALID", "MFA code is invalid.");
    const codes = recoveryCodes();
    await transaction(async (client) => {
      await client.query("UPDATE platform_admins SET mfa_enabled=true,recovery_code_hashes=$2,updated_at=now() WHERE user_id=$1", [principal.userId, codes.map((code) => sha256(code))]);
      await client.query("UPDATE sessions SET mfa_verified_at=now() WHERE id=$1", [principal.sessionId]);
    });
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "ADMIN_MFA_ENABLED", resourceType: "user", resourceId: principal.userId, request });
    reply.send({ ok: true, recoveryCodes: codes });
  });

  app.post("/v1/admin/mfa/recovery-codes", async (request, reply) => {
    const principal = await requireRecentPlatformAdmin(request, { roles: platformAdminRoles });
    requireCsrf(request);
    const codes = recoveryCodes();
    await query("UPDATE platform_admins SET recovery_code_hashes=$2,updated_at=now() WHERE user_id=$1 AND mfa_enabled=true", [principal.userId, codes.map((code) => sha256(code))]);
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "ADMIN_RECOVERY_CODES_ROTATED", resourceType: "user", resourceId: principal.userId, request });
    reply.send({ recoveryCodes: codes });
  });

  app.post("/v1/admin/mfa/reauth", async (request, reply) => {
    const principal = await requirePlatformAdmin(request, { roles: platformAdminRoles });
    requireCsrf(request);
    const input = z.object({ code: z.string().min(6).max(30) }).parse(request.body);
    await mfaRateLimit(`reauth:${principal.userId}:${principal.sessionId}`);
    const admin = await query<any>("SELECT mfa_secret_encrypted,recovery_code_hashes FROM platform_admins WHERE user_id=$1 AND active=true AND mfa_enabled=true", [principal.userId]);
    const row = admin.rows[0];
    if (!row?.mfa_secret_encrypted) throw new ApiError(400, "MFA_NOT_ENABLED", "MFA is not enabled.");
    const result = await verifyCode(row, input.code);
    if (!result.valid) throw new ApiError(401, "MFA_CODE_INVALID", "MFA code is invalid.");
    await transaction(async (client) => {
      await client.query("UPDATE sessions SET mfa_verified_at=now(),last_seen_at=now() WHERE id=$1", [principal.sessionId]);
      if (result.recoveryHash) await client.query("UPDATE platform_admins SET recovery_code_hashes=array_remove(recovery_code_hashes,$2),updated_at=now() WHERE user_id=$1", [principal.userId, result.recoveryHash]);
    });
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "ADMIN_REAUTHENTICATED", resourceType: "session", resourceId: principal.sessionId, request });
    reply.send({ ok: true, mfaVerifiedAt: new Date().toISOString() });
  });
}
