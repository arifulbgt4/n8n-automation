import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  decryptSecret,
  encryptSecret,
  env,
  maskSecret,
  query,
  randomToken,
  redis,
  redisKey,
  sha256,
  transaction,
} from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";
import { assertChannelOverrideWithinPlan, assertTenantCountLimit } from "../limits.js";

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

async function metaOAuthConfig() {
  const config = env();
  if (!config.META_APP_ID || !config.META_APP_SECRET || !config.META_OAUTH_REDIRECT_URI) {
    throw new ApiError(503,"META_OAUTH_NOT_CONFIGURED","Meta OAuth is not configured for this environment.");
  }
  return config;
}

type MetaDiscovery = {
  tenantId: string;
  businessId: string;
  userId: string;
  requestedPlatform: "facebook" | "instagram";
  pages: Array<{ id: string; name: string; accessToken: string; instagram?: { id: string; username?: string } | null }>;
};

export async function channelRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/channels/meta/oauth/start", async (request, reply) => {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const q = z.object({ businessId: z.string().uuid(), platform: z.enum(["facebook","instagram"]) }).parse(request.query);
    const principal = await requireAuth(request);
    await requireBusinessAccess(request, tenantId, q.businessId, ["OWNER","ADMIN"]);
    const config = await metaOAuthConfig();
    const state = randomToken(28);
    await redis().set(redisKey("meta-oauth","state",state), JSON.stringify({
      tenantId,businessId:q.businessId,userId:principal.userId,requestedPlatform:q.platform,createdAt:new Date().toISOString(),
    }), "EX", 600);
    const scope = q.platform === "instagram"
      ? ["pages_show_list","pages_read_engagement","instagram_basic","instagram_manage_messages","pages_manage_metadata"]
      : ["pages_show_list","pages_read_engagement","pages_messaging","pages_manage_metadata"];
    const url = new URL(`https://www.facebook.com/${config.META_GRAPH_API_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", config.META_APP_ID!);
    url.searchParams.set("redirect_uri", config.META_OAUTH_REDIRECT_URI!);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scope.join(","));
    reply.send({ authorizationUrl: url.toString(), expiresInSeconds: 600 });
  });

  app.get("/v1/channels/meta/oauth/callback", async (request, reply) => {
    const q = z.object({ code: z.string().min(1).optional(), state: z.string().min(20), error: z.string().optional(), error_description: z.string().optional() }).parse(request.query);
    const config = await metaOAuthConfig();
    const key = redisKey("meta-oauth","state",q.state);
    const raw = await redis().get(key);
    await redis().del(key);
    if (!raw) throw new ApiError(400,"META_OAUTH_STATE_INVALID","Meta OAuth state is invalid or expired.");
    const state = JSON.parse(raw) as { tenantId: string; businessId: string; userId: string; requestedPlatform: "facebook"|"instagram" };
    if (q.error || !q.code) {
      const failed = new URL("/channels", config.CUSTOMER_APP_ORIGIN);
      failed.searchParams.set("metaError", q.error_description || q.error || "oauth_cancelled");
      return reply.redirect(failed.toString());
    }

    const tokenUrl = new URL(`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", config.META_APP_ID!);
    tokenUrl.searchParams.set("client_secret", config.META_APP_SECRET!);
    tokenUrl.searchParams.set("redirect_uri", config.META_OAUTH_REDIRECT_URI!);
    tokenUrl.searchParams.set("code", q.code);
    const tokenResponse = await fetch(tokenUrl);
    const tokenBody = await tokenResponse.json().catch(() => ({})) as any;
    if (!tokenResponse.ok || !tokenBody.access_token) throw new ApiError(502,"META_OAUTH_EXCHANGE_FAILED",tokenBody?.error?.message || "Meta token exchange failed.");

    let userToken = String(tokenBody.access_token);
    const longUrl = new URL(`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/oauth/access_token`);
    longUrl.searchParams.set("grant_type","fb_exchange_token");
    longUrl.searchParams.set("client_id",config.META_APP_ID!);
    longUrl.searchParams.set("client_secret",config.META_APP_SECRET!);
    longUrl.searchParams.set("fb_exchange_token",userToken);
    const longResponse = await fetch(longUrl);
    if (longResponse.ok) {
      const body = await longResponse.json().catch(() => ({})) as any;
      if (body.access_token) userToken = String(body.access_token);
    }

    const pagesUrl = new URL(`https://graph.facebook.com/${config.META_GRAPH_API_VERSION}/me/accounts`);
    pagesUrl.searchParams.set("fields","id,name,access_token,instagram_business_account{id,username}");
    pagesUrl.searchParams.set("limit","200");
    pagesUrl.searchParams.set("access_token",userToken);
    const pagesResponse = await fetch(pagesUrl);
    const pagesBody = await pagesResponse.json().catch(() => ({})) as any;
    if (!pagesResponse.ok) throw new ApiError(502,"META_PAGE_DISCOVERY_FAILED",pagesBody?.error?.message || "Unable to discover Meta Pages.");
    const pages = (pagesBody.data ?? []).map((page: any) => ({
      id:String(page.id),name:String(page.name || page.id),accessToken:String(page.access_token || userToken),
      instagram:page.instagram_business_account ? { id:String(page.instagram_business_account.id), username:page.instagram_business_account.username ? String(page.instagram_business_account.username) : undefined } : null,
    }));
    const discoveryId = randomToken(24);
    const discovery: MetaDiscovery = { tenantId:state.tenantId,businessId:state.businessId,userId:state.userId,requestedPlatform:state.requestedPlatform,pages };
    await redis().set(redisKey("meta-oauth","discovery",discoveryId), encryptSecret(JSON.stringify(discovery)), "EX", 900);
    const destination = new URL("/channels", config.CUSTOMER_APP_ORIGIN);
    destination.searchParams.set("metaConnection",discoveryId);
    return reply.redirect(destination.toString());
  });

  app.get("/v1/tenants/:tenantId/channels/meta/oauth/discovery/:discoveryId", async (request, reply) => {
    const params = z.object({ tenantId:z.string().uuid(),discoveryId:z.string().min(20) }).parse(request.params);
    const principal = await requireAuth(request);
    const value = await redis().get(redisKey("meta-oauth","discovery",params.discoveryId));
    if (!value) throw new ApiError(404,"META_DISCOVERY_NOT_FOUND","Meta connection selection expired.");
    const discovery = JSON.parse(decryptSecret(value)) as MetaDiscovery;
    if (discovery.tenantId !== params.tenantId || discovery.userId !== principal.userId) throw new ApiError(404,"META_DISCOVERY_NOT_FOUND","Meta connection selection not found.");
    await requireBusinessAccess(request, params.tenantId, discovery.businessId, ["OWNER","ADMIN"]);
    reply.send({
      requestedPlatform:discovery.requestedPlatform,
      businessId:discovery.businessId,
      pages:discovery.pages.map((page)=>({id:page.id,name:page.name,instagram:page.instagram ?? null})),
    });
  });

  app.post("/v1/tenants/:tenantId/channels/meta/oauth/discovery/:discoveryId/complete", async (request, reply) => {
    const params = z.object({ tenantId:z.string().uuid(),discoveryId:z.string().min(20) }).parse(request.params);
    const principal = await requireAuth(request);
    requireCsrf(request);
    const input = z.object({ pageId:z.string().min(1), platform:z.enum(["facebook","instagram"]) }).parse(request.body);
    const key = redisKey("meta-oauth","discovery",params.discoveryId);
    const value = await redis().get(key);
    if (!value) throw new ApiError(404,"META_DISCOVERY_NOT_FOUND","Meta connection selection expired.");
    const discovery = JSON.parse(decryptSecret(value)) as MetaDiscovery;
    if (discovery.tenantId !== params.tenantId || discovery.userId !== principal.userId) throw new ApiError(404,"META_DISCOVERY_NOT_FOUND","Meta connection selection not found.");
    await requireBusinessAccess(request, params.tenantId, discovery.businessId, ["OWNER","ADMIN"]);
    const page = discovery.pages.find((candidate)=>candidate.id===input.pageId);
    if (!page) throw new ApiError(400,"META_PAGE_INVALID","Selected Page is not available in this connection.");
    const externalAccountId = input.platform === "facebook" ? page.id : page.instagram?.id;
    if (!externalAccountId) throw new ApiError(400,"INSTAGRAM_ACCOUNT_MISSING","Selected Page has no connected Instagram professional account.");
    const name = input.platform === "facebook" ? page.name : (page.instagram?.username || `${page.name} Instagram`);
    const duplicate = await query("SELECT id FROM channel_accounts WHERE platform=$1 AND external_account_id=$2",[input.platform,externalAccountId]);
    if (duplicate.rowCount) throw new ApiError(409,"CHANNEL_ALREADY_CONNECTED","This channel account is already connected.");
    const created = await query<any>(`
      INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,connection_status,graph_api_version,settings_json)
      VALUES ($1,$2,$3,$4,$5,'connected',$6,$7::jsonb) RETURNING *
    `, [params.tenantId,discovery.businessId,input.platform,name,externalAccountId,env().META_GRAPH_API_VERSION,JSON.stringify({connectedVia:"meta_oauth",facebookPageId:page.id})]);
    await upsertCredential(params.tenantId,created.rows[0].id,"access_token",page.accessToken);
    if (env().META_APP_SECRET) await upsertCredential(params.tenantId,created.rows[0].id,"app_secret",env().META_APP_SECRET!);
    await redis().del(key);
    await audit({ actorUserId:principal.userId,tenantId:params.tenantId,businessId:discovery.businessId,action:"CHANNEL_CONNECTED",resourceType:"channel_account",resourceId:created.rows[0].id,safeDiff:{platform:input.platform,externalAccountId,via:"meta_oauth"},request });
    reply.code(201).send({ channel:created.rows[0] });
  });

  app.get("/v1/tenants/:tenantId/channels", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const context = await requireTenant(request, params.tenantId);
    const scope = context.membershipRole === "OWNER" ? null : context.businessScope ?? null;
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
        AND ($4::uuid[] IS NULL OR c.business_id=ANY($4::uuid[]))
      ORDER BY c.created_at DESC
    `, [params.tenantId, queryParams.businessId ?? null, queryParams.platform ?? null, scope]);
    reply.send({ channels: result.rows });
  });

  app.post("/v1/tenants/:tenantId/channels", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);
    await assertTenantCountLimit(params.tenantId, "channels", "SELECT count(*) FROM channel_accounts WHERE tenant_id=$1 AND active=true");
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
    await requireBusinessAccess(request, params.tenantId, input.businessId, ["OWNER", "ADMIN"]);
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
    await requireBusinessAccess(request, params.tenantId, result.rows[0].business_id);
    reply.send({ channel: result.rows[0] });
  });

  app.patch("/v1/tenants/:tenantId/channels/:channelId", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), channelId: z.string().uuid() }).parse(request.params);
    const principal = await requireAuth(request);
    const existingChannel = await query<{ business_id: string }>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [params.channelId,params.tenantId]);
    if (!existingChannel.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await requireBusinessAccess(request, params.tenantId, existingChannel.rows[0].business_id, ["OWNER", "ADMIN"]);
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
    await requireBusinessAccess(request, params.tenantId, result.rows[0].business_id, ["OWNER", "ADMIN", "STAFF"]);
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
    for (const [key,value] of Object.entries(input)) await assertChannelOverrideWithinPlan(params.tenantId,key,value);
    const channel = await query<{ business_id: string }>("SELECT business_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2", [params.channelId, params.tenantId]);
    if (!channel.rows[0]) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await requireBusinessAccess(request, params.tenantId, channel.rows[0].business_id, ["OWNER", "ADMIN"]);
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
    await requireBusinessAccess(request, params.tenantId, channel.rows[0].business_id, ["OWNER", "ADMIN"]);
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
