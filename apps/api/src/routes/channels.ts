import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  env,
  maskSecret,
  query,
  sha256,
  transaction,
} from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireCsrf, requireTenant } from "../lib.js";

const platformSchema = z.enum(["facebook", "instagram", "whatsapp"]);
const credentialInput = z.object({
  accessToken: z.string().min(8).optional(),
  appSecret: z.string().min(8).optional(),
  verifyToken: z.string().min(4).optional(),
  whatsappBusinessAccountId: z.string().optional(),
});

async function ensureBusiness(tenantId: string, businessId: string) {
  const result = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2 AND status<>'archived'", [businessId, tenantId]);
  if (!result.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
}

async function upsertCredential(tenantId: string, channelId: string, type: string, value: string) {
  await query(`
    INSERT INTO channel_credentials(tenant_id,channel_account_id,credential_type,encrypted_value,key_hint)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(channel_account_id,credential_type)
    DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,key_hint=EXCLUDED.key_hint,rotated_at=now(),updated_at=now()
  `, [tenantId, channelId, type, encryptSecret(value), maskSecret(value)]);
}

async function credentialValue(channelId: string, type: string): Promise<string | null> {
  const result = await query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM channel_credentials WHERE channel_account_id=$1 AND credential_type=$2",
    [channelId, type],
  );
  return result.rows[0] ? decryptSecret(result.rows[0].encrypted_value) : null;
}

async function testMetaChannel(channel: { id: string; platform: string; external_account_id: string }): Promise<{ ok: boolean; detail: string }> {
  const accessToken = await credentialValue(channel.id, "access_token");
  if (!accessToken) return { ok: false, detail: "Access token is not configured." };
  const version = env().META_GRAPH_API_VERSION;
  const url = channel.platform === "whatsapp"
    ? `https://graph.facebook.com/${version}/${encodeURIComponent(channel.external_account_id)}?fields=id,display_phone_number,verified_name`
    : `https://graph.facebook.com/${version}/${encodeURIComponent(channel.external_account_id)}?fields=id,name`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = await response.text();
    if (!response.ok) return { ok: false, detail: `Meta returned ${response.status}: ${body.slice(0, 240)}` };
    return { ok: true, detail: "Connection verified." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "Connection test failed." };
  }
}

export async function channelRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/channels", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const queryParams = z.object({ businessId: z.string().uuid().optional(), platform: platformSchema.optional() }).parse(request.query);
    const result = await query(`
      SELECT c.*, b.name AS business_name,
             (SELECT jsonb_object_agg(cc.credential_type, cc.key_hint) FROM channel_credentials cc WHERE cc.channel_account_id=c.id) AS credential_hints,
             (SELECT count(*)::int FROM collection_channel_links l WHERE l.channel_account_id=c.id AND l.active=true) AS linked_collections
      FROM channel_accounts c
      JOIN businesses b ON b.id=c.business_id
      WHERE c.tenant_id=$1
        AND ($2::uuid IS NULL OR c.business_id=$2)
        AND ($3::text IS NULL OR c.platform=$3)
      ORDER BY c.created_at DESC
    `, [params.tenantId, queryParams.businessId ?? null, queryParams.platform ?? null]);
    reply.send({ channels: result.rows });
  });

  app.post("/v1/tenants/:tenantId/channels", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      businessId: z.string().uuid(),
      platform: platformSchema,
      name: z.string().trim().min(1).max(160),
      externalAccountId: z.string().trim().min(1).max(255),
      publicIdentifier: z.string().trim().max(255).optional(),
      graphApiVersion: z.string().trim().max(32).optional(),
      settings: z.record(z.string(), z.unknown()).default({}),
      credentials: credentialInput.default({}),
      testConnection: z.boolean().default(true),
    }).parse(request.body);
    await ensureBusiness(params.tenantId, input.businessId);
    const existing = await query("SELECT id FROM channel_accounts WHERE platform=$1 AND external_account_id=$2", [input.platform, input.externalAccountId]);
    if (existing.rowCount) throw new ApiError(409, "CHANNEL_ALREADY_CONNECTED", "This channel account is already connected.");

    const channel = await transaction(async (client) => {
      const created = await client.query<{
        id: string; platform: string; external_account_id: string; [key: string]: unknown;
      }>(`
        INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,public_identifier,graph_api_version,settings_json)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        RETURNING *
      `, [params.tenantId, input.businessId, input.platform, input.name, input.externalAccountId, input.publicIdentifier ?? null, input.graphApiVersion ?? env().META_GRAPH_API_VERSION, JSON.stringify(input.settings)]);
      return created.rows[0];
    });

    if (input.credentials.accessToken) await upsertCredential(params.tenantId, channel.id, "access_token", input.credentials.accessToken);
    if (input.credentials.appSecret) await upsertCredential(params.tenantId, channel.id, "app_secret", input.credentials.appSecret);
    if (input.credentials.verifyToken) await upsertCredential(params.tenantId, channel.id, "verify_token", input.credentials.verifyToken);
    if (input.credentials.whatsappBusinessAccountId) await upsertCredential(params.tenantId, channel.id, "whatsapp_business_account_id", input.credentials.whatsappBusinessAccountId);

    let test: { ok: boolean; detail: string } | undefined;
    if (input.testConnection && input.credentials.accessToken) {
      test = await testMetaChannel(channel);
      await query("UPDATE channel_accounts SET connection_status=$2,updated_at=now() WHERE id=$1", [channel.id, test.ok ? "connected" : "degraded"]);
    }
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: input.businessId, action: "CHANNEL_CONNECTED", resourceType: "channel_account", resourceId: channel.id, safeDiff: { platform: input.platform, externalAccountId: input.externalAccountId }, request });
    reply.code(201).send({ channel: { ...channel, connection_status: test ? (test.ok ? "connected" : "degraded") : channel.connection_status }, connectionTest: test });
  });

  app.get("/v1/tenants/:tenantId/channels/:channelId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId);
    const result = await query(`
      SELECT c.*, b.name AS business_name,
             COALESCE((SELECT jsonb_object_agg(cc.credential_type,cc.key_hint) FROM channel_credentials cc WHERE cc.channel_account_id=c.id),'{}'::jsonb) AS credential_hints
      FROM channel_accounts c JOIN businesses b ON b.id=c.business_id
      WHERE c.id=$1 AND c.tenant_id=$2
    `, [params.channelId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    reply.send({ channel: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/channels/:channelId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.object({
      name: z.string().trim().min(1).max(160).optional(),
      active: z.boolean().optional(),
      defaultAgentProfileId: z.string().uuid().nullable().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
      credentials: credentialInput.optional(),
    }).parse(request.body);
    const result = await query(`
      UPDATE channel_accounts SET
        name=COALESCE($3,name),
        active=COALESCE($4,active),
        default_agent_profile_id=CASE WHEN $5::boolean THEN $6::uuid ELSE default_agent_profile_id END,
        settings_json=CASE WHEN $7::jsonb IS NULL THEN settings_json ELSE settings_json || $7::jsonb END,
        updated_at=now()
      WHERE id=$1 AND tenant_id=$2 RETURNING *
    `, [params.channelId, params.tenantId, input.name ?? null, input.active ?? null, Object.prototype.hasOwnProperty.call(input, "defaultAgentProfileId"), input.defaultAgentProfileId ?? null, input.settings ? JSON.stringify(input.settings) : null]);
    const channel = result.rows[0];
    if (!channel) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    if (input.credentials?.accessToken) await upsertCredential(params.tenantId, params.channelId, "access_token", input.credentials.accessToken);
    if (input.credentials?.appSecret) await upsertCredential(params.tenantId, params.channelId, "app_secret", input.credentials.appSecret);
    if (input.credentials?.verifyToken) await upsertCredential(params.tenantId, params.channelId, "verify_token", input.credentials.verifyToken);
    if (input.credentials?.whatsappBusinessAccountId) await upsertCredential(params.tenantId, params.channelId, "whatsapp_business_account_id", input.credentials.whatsappBusinessAccountId);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: channel.business_id, action: "CHANNEL_UPDATED", resourceType: "channel_account", resourceId: params.channelId, safeDiff: { ...input, credentials: input.credentials ? Object.keys(input.credentials) : undefined }, request });
    reply.send({ channel });
  });

  app.post("/v1/tenants/:tenantId/channels/:channelId/test", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN", "STAFF"]);
    const principal = await requireAuth(request);
    requireCsrf(request);
    const result = await query<{ id: string; platform: string; external_account_id: string; business_id: string }>("SELECT id,platform,external_account_id,business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [params.channelId, params.tenantId]);
    if (!result.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    const test = await testMetaChannel(result.rows[0]);
    await query("UPDATE channel_accounts SET connection_status=$2,updated_at=now() WHERE id=$1", [params.channelId, test.ok ? "connected" : "degraded"]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: result.rows[0].business_id, action: "CHANNEL_TESTED", resourceType: "channel_account", resourceId: params.channelId, safeDiff: { ok: test.ok }, request });
    reply.send(test);
  });

  app.put("/v1/tenants/:tenantId/channels/:channelId/limits", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const input = z.record(z.string().min(1).max(100), z.number().nonnegative()).parse(request.body);
    const channel = await query<{ business_id: string }>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [params.channelId, params.tenantId]);
    if (!channel.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await transaction(async (client) => {
      for (const [key, value] of Object.entries(input)) {
        await client.query(`
          INSERT INTO channel_limit_overrides(tenant_id,channel_account_id,key,value)
          VALUES ($1,$2,$3,$4)
          ON CONFLICT(channel_account_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()
        `, [params.tenantId, params.channelId, key, value]);
      }
    });
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: channel.rows[0].business_id, action: "CHANNEL_LIMITS_UPDATED", resourceType: "channel_account", resourceId: params.channelId, safeDiff: input, request });
    reply.send({ ok: true, limits: input });
  });

  app.delete("/v1/tenants/:tenantId/channels/:channelId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    const channel = await query<{ business_id: string }>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [params.channelId, params.tenantId]);
    if (!channel.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await query("UPDATE channel_accounts SET active=false,connection_status='disconnected',updated_at=now() WHERE id=$1", [params.channelId]);
    await query("DELETE FROM channel_credentials WHERE channel_account_id=$1", [params.channelId]);
    await audit({ actorUserId: principal.userId, tenantId: params.tenantId, businessId: channel.rows[0].business_id, action: "CHANNEL_DISCONNECTED", resourceType: "channel_account", resourceId: params.channelId, request });
    reply.send({ ok: true });
  });

  app.get("/v1/internal/channels/:channelId/credentials", async (request, reply) => {
    const secret = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!secret || sha256(secret) !== sha256(env().INTERNAL_SERVICE_AUTH_SECRET)) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Unauthorized.");
    const { channelId } = z.object({ channelId: z.string().uuid() }).parse(request.params);
    const result = await query<{ credential_type: string; encrypted_value: string }>("SELECT credential_type,encrypted_value FROM channel_credentials WHERE channel_account_id=$1", [channelId]);
    const credentials = Object.fromEntries(result.rows.map((row) => [row.credential_type, decryptSecret(row.encrypted_value)]));
    reply.send({ credentials });
  });
}
