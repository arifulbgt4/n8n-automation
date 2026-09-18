import { Worker, type Job } from "bullmq";
import {
  decryptSecret,
  env,
  query,
  QUEUES,
  redis,
  redisKey,
  sha256,
  transaction,
  type JobEnvelope,
} from "@n8n-automation/core";

const config = env();
const workers: Worker[] = [];

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "worker", event, ...data }));
}

async function internalFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${config.INTERNAL_SERVICE_AUTH_SECRET}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${config.API_PUBLIC_ORIGIN.replace(/\/$/, "")}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((body as any)?.error?.message || `Internal API ${path} failed with ${response.status}`);
    (error as any).status = response.status;
    (error as any).body = body;
    throw error;
  }
  return body as any;
}

async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;
  const result = await redis().set(key, token, "PX", ttlMs, "NX");
  return result === "OK" ? token : null;
}

async function releaseLock(key: string, token: string) {
  await redis().eval(`if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`, 1, key, token);
}

async function rateLimit(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const now = Date.now();
  const script = `
    local key=KEYS[1]
    local now=tonumber(ARGV[1])
    local window=tonumber(ARGV[2])
    local limit=tonumber(ARGV[3])
    redis.call('ZREMRANGEBYSCORE',key,0,now-window)
    local count=redis.call('ZCARD',key)
    if count >= limit then
      local oldest=redis.call('ZRANGE',key,0,0,'WITHSCORES')
      local retry=window
      if oldest[2] then retry=math.max(1,window-(now-tonumber(oldest[2]))) end
      redis.call('PEXPIRE',key,window)
      return {0,retry}
    end
    redis.call('ZADD',key,now,tostring(now)..'-'..tostring(math.random()))
    redis.call('PEXPIRE',key,window)
    return {1,0}
  `;
  const result = await redis().eval(script, 1, key, now, windowMs, limit) as [number, number];
  return { allowed: Number(result[0]) === 1, retryAfterMs: Number(result[1]) };
}

async function aggregateConversation(job: Job<JobEnvelope<any>>) {
  const { conversationId, tenantId, businessId, channelAccountId, correlationId } = job.data;
  if (!conversationId || !businessId || !channelAccountId) return;
  const lockKey = redisKey("lock", "aggregation", conversationId);
  const lock = await acquireLock(lockKey, 20_000);
  if (!lock) return;
  try {
    const cv = await query<any>("SELECT mode,status,last_message_at,agent_profile_id FROM conversations WHERE id=$1 AND tenant_id=$2", [conversationId, tenantId]);
    if (!cv.rows[0] || cv.rows[0].status !== "open" || cv.rows[0].mode !== "AI") return;
    const mediaPending = await query<{ count: string; oldest: Date | null }>(`
      SELECT count(*)::text AS count,min(created_at) AS oldest
      FROM messages
      WHERE conversation_id=$1 AND direction='INBOUND' AND turn_id IS NULL
        AND metadata->>'mediaIngestStatus'='pending'
    `, [conversationId]);
    if (Number(mediaPending.rows[0]?.count ?? 0) > 0) {
      const oldestAt = mediaPending.rows[0]?.oldest ? new Date(mediaPending.rows[0].oldest).getTime() : Date.now();
      if (Date.now() - oldestAt < 30_000) {
        await job.moveToDelayed(Date.now() + 750, job.token!);
        return;
      }
    }
    const pending = await query<any>(`
      SELECT id,created_at FROM messages
      WHERE conversation_id=$1 AND direction='INBOUND' AND turn_id IS NULL AND sender_type='CONTACT'
      ORDER BY created_at ASC LIMIT $2
    `, [conversationId, config.AGGREGATION_MAX_MESSAGES]);
    if (!pending.rows.length) return;
    const latest = pending.rows[pending.rows.length - 1];
    const ageMs = Date.now() - new Date(latest.created_at).getTime();
    if (ageMs < config.AGGREGATION_WINDOW_MS - 100) {
      const delay = config.AGGREGATION_WINDOW_MS - ageMs;
      await job.moveToDelayed(Date.now() + delay, job.token!);
      return;
    }
    const turn = await transaction(async (client) => {
      const locked = await client.query<any>("SELECT id,mode,status FROM conversations WHERE id=$1 FOR UPDATE", [conversationId]);
      if (!locked.rows[0] || locked.rows[0].mode !== "AI" || locked.rows[0].status !== "open") return null;
      const messages = await client.query<{ id: string }>(`
        SELECT id FROM messages WHERE conversation_id=$1 AND direction='INBOUND' AND turn_id IS NULL AND sender_type='CONTACT'
        ORDER BY created_at ASC LIMIT $2 FOR UPDATE
      `, [conversationId, config.AGGREGATION_MAX_MESSAGES]);
      if (!messages.rows.length) return null;
      const created = await client.query<{ id: string }>(`
        INSERT INTO conversation_turns(tenant_id,conversation_id,speaker,status,metadata)
        VALUES ($1,$2,'CONTACT','ready',$3::jsonb) RETURNING id
      `, [tenantId, conversationId, JSON.stringify({ correlationId, messageCount: messages.rows.length })]);
      const ids = messages.rows.map((row) => row.id);
      await client.query("UPDATE messages SET turn_id=$2,updated_at=now() WHERE id=ANY($1::uuid[])", [ids, created.rows[0].id]);
      await client.query("UPDATE conversations SET last_turn_at=now(),updated_at=now() WHERE id=$1", [conversationId]);
      await client.query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key)
        VALUES ($1,$2,$3,$4,'conversation_turn',1,'turn',$5,$6) ON CONFLICT DO NOTHING`, [tenantId, businessId, channelAccountId, conversationId, correlationId, `turn:${created.rows[0].id}`]);
      return created.rows[0].id;
    });
    if (!turn) return;
    log("turn_ready", { turnId: turn, tenantId, conversationId });
    if (config.N8N_TURN_WEBHOOK_URL) {
      const response = await fetch(config.N8N_TURN_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.INTERNAL_SERVICE_AUTH_SECRET}` },
        body: JSON.stringify({ turnId: turn, tenantId, businessId, channelAccountId, conversationId, correlationId }),
      });
      if (!response.ok) throw new Error(`n8n turn webhook failed with ${response.status}`);
    } else {
      const ai = await internalFetch("/v1/internal/ai/respond", { method: "POST", body: JSON.stringify({ turnId: turn }) });
      for (let index = 0; index < (ai.actions ?? []).length; index++) {
        const action = ai.actions[index];
        await internalFetch("/v1/internal/actions/execute", {
          method: "POST",
          body: JSON.stringify({
            tenantId: ai.tenantId,
            businessId: ai.businessId,
            channelAccountId: ai.channelAccountId,
            conversationId: ai.conversationId,
            tool: action.tool,
            arguments: action.arguments ?? {},
            idempotencyKey: `turn:${turn}:action:${index}:${action.tool}`,
          }),
        });
      }
      if (ai.handoff) {
        await internalFetch("/v1/internal/actions/execute", { method: "POST", body: JSON.stringify({ tenantId: ai.tenantId, businessId: ai.businessId, channelAccountId: ai.channelAccountId, conversationId: ai.conversationId, tool: "handoff_conversation", arguments: { reason: ai.handoffReason }, idempotencyKey: `turn:${turn}:handoff` }) });
      } else if (ai.messages?.length) {
        await internalFetch("/v1/internal/outbound/enqueue", { method: "POST", body: JSON.stringify({ tenantId: ai.tenantId, businessId: ai.businessId, channelAccountId: ai.channelAccountId, conversationId: ai.conversationId, stateVersion: Number(ai.stateVersion), messages: ai.messages, senderType: "AI", priority: "CUSTOMER_ACTIVE", logicalResponseId: `turn-${turn}` }) });
      }
      await internalFetch(`/v1/internal/turns/${turn}/complete`, { method: "POST", body: JSON.stringify({ status: "processed" }) });
    }
  } finally {
    await releaseLock(lockKey, lock);
  }
}

async function tenantMediaCredential(tenantId: string): Promise<string> {
  const result = await query<{ encrypted_api_key: string | null }>("SELECT encrypted_api_key FROM tenant_media_accounts WHERE tenant_id=$1 AND status='active'", [tenantId]);
  if (result.rows[0]?.encrypted_api_key) return decryptSecret(result.rows[0].encrypted_api_key);
  if (config.MEDIA_API_KEY) return config.MEDIA_API_KEY;
  throw new Error("Media credential is not configured");
}

async function loadAsset(tenantId: string, assetId: string) {
  const result = await query<any>("SELECT * FROM media_assets WHERE id=$1 AND tenant_id=$2 AND processing_status='ready'", [assetId, tenantId]);
  if (!result.rows[0]) throw new Error(`Media asset ${assetId} not found`);
  return result.rows[0];
}

async function fetchAssetBytes(tenantId: string, asset: any): Promise<{ bytes: ArrayBuffer; mime: string }> {
  if (!config.MEDIA_BASE_URL) throw new Error("MEDIA_BASE_URL is not configured");
  const credential = await tenantMediaCredential(tenantId);
  const response = await fetch(`${config.MEDIA_BASE_URL.replace(/\/$/, "")}/api/v1/files/${encodeURIComponent(asset.storage_file_id)}/content`, { headers: { authorization: `Bearer ${credential}` } });
  if (!response.ok) throw new Error(`Media download failed with ${response.status}`);
  return { bytes: await response.arrayBuffer(), mime: response.headers.get("content-type") || asset.mime_type || "application/octet-stream" };
}


async function fetchInboundMedia(messageId: string) {
  const result = await query<any>(`
    SELECT m.id,m.tenant_id,m.business_id,m.channel_account_id,m.conversation_id,m.message_type,m.metadata,
           ca.platform,ca.external_account_id,ca.graph_api_version
      FROM messages m
      JOIN channel_accounts ca ON ca.id=m.channel_account_id
     WHERE m.id=$1 AND m.direction='INBOUND'
  `, [messageId]);
  const row = result.rows[0];
  if (!row) throw new Error("Inbound message for media ingestion was not found");
  const credentials = await query<{ credential_type: string; encrypted_value: string }>(
    "SELECT credential_type,encrypted_value FROM channel_credentials WHERE channel_account_id=$1",
    [row.channel_account_id],
  );
  const resolved = Object.fromEntries(credentials.rows.map((item) => [item.credential_type, decryptSecret(item.encrypted_value)]));
  const accessToken = resolved.access_token;
  if (!accessToken) throw new Error("Channel access token is missing for inbound media ingestion");

  let sourceUrl = String(row.metadata?.providerMediaUrl || "");
  let mime = String(row.metadata?.providerMimeType || "");
  let filename = String(row.metadata?.providerFilename || `inbound-${messageId}`);

  if (row.platform === "whatsapp") {
    const mediaId = String(row.metadata?.providerMediaId || "");
    if (!mediaId) throw new Error("WhatsApp inbound media ID is missing");
    const version = row.graph_api_version || config.META_GRAPH_API_VERSION;
    const infoResponse = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const info = await infoResponse.json().catch(() => ({}));
    if (!infoResponse.ok || !(info as any).url) {
      throw new Error((info as any)?.error?.message || `WhatsApp media lookup failed with ${infoResponse.status}`);
    }
    sourceUrl = String((info as any).url);
    mime = mime || String((info as any).mime_type || "");
  }

  if (!sourceUrl) throw new Error("Inbound media source URL is missing");
  const download = await fetch(sourceUrl, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!download.ok) throw new Error(`Inbound media download failed with ${download.status}`);
  mime = download.headers.get("content-type") || mime || "application/octet-stream";
  const disposition = download.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  if (match?.[1]) filename = match[1];
  return { row, bytes: await download.arrayBuffer(), mime, filename };
}

async function uploadInboundMedia(job: Job<JobEnvelope<any>>) {
  const messageId = String(job.data.payload.messageId || "");
  if (!messageId) throw new Error("Media ingestion job is missing messageId");
  const existingLink = await query("SELECT 1 FROM message_media WHERE message_id=$1 LIMIT 1", [messageId]);
  if (existingLink.rowCount) {
    await query("UPDATE messages SET metadata=metadata||'{\"mediaIngestStatus\":\"ready\"}'::jsonb,updated_at=now() WHERE id=$1", [messageId]);
    return;
  }

  try {
    const { row, bytes, mime, filename } = await fetchInboundMedia(messageId);
    if (!config.MEDIA_BASE_URL) throw new Error("MEDIA_BASE_URL is not configured");
    const credential = await tenantMediaCredential(row.tenant_id);
    const form = new FormData();
    form.set("visibility", "private");
    form.set("file", new Blob([bytes], { type: mime }), filename);
    const upload = await fetch(`${config.MEDIA_BASE_URL.replace(/\/$/, "")}/api/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      body: form,
    });
    const body = await upload.json().catch(() => ({}));
    if (!upload.ok) throw new Error((body as any)?.error?.message || (body as any)?.message || `Media Storage upload failed with ${upload.status}`);
    const file = (body as any).file ?? body;
    if (!file?.id) throw new Error("Media Storage upload did not return a file ID");

    const assetId = await transaction(async (client) => {
      if (file.checksum_sha256) {
        const duplicate = await client.query<{ id: string }>(
          "SELECT id FROM media_assets WHERE tenant_id=$1 AND content_hash=$2 AND processing_status='ready' ORDER BY created_at LIMIT 1",
          [row.tenant_id, file.checksum_sha256],
        );
        if (duplicate.rows[0]) return duplicate.rows[0].id;
      }
      const asset = await client.query<{ id: string }>(`
        INSERT INTO media_assets(
          tenant_id,business_id,storage_file_id,storage_user_id,original_name,mime_type,kind,size_bytes,
          visibility,content_hash,public_url,processing_status,metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'private',$9,$10,'ready',$11::jsonb)
        RETURNING id
      `, [
        row.tenant_id,row.business_id,String(file.id),file.user_id ? String(file.user_id) : null,
        file.original_name ?? filename,file.mime_type ?? mime,file.kind ?? row.message_type,Number(file.size_bytes ?? bytes.byteLength),
        file.checksum_sha256 ?? null,file.public_url ?? null,JSON.stringify({ source: "inbound_message", messageId }),
      ]);
      return asset.rows[0].id;
    });

    if (file.checksum_sha256) {
      const mapped = await query<{ storage_file_id: string }>("SELECT storage_file_id FROM media_assets WHERE id=$1", [assetId]);
      if (mapped.rows[0] && mapped.rows[0].storage_file_id !== String(file.id)) {
        await fetch(`${config.MEDIA_BASE_URL.replace(/\/$/, "")}/api/v1/files/${encodeURIComponent(String(file.id))}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${credential}` },
        }).catch(() => undefined);
      }
    }

    await transaction(async (client) => {
      await client.query(
        "INSERT INTO message_media(message_id,media_asset_id,tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [messageId,assetId,row.tenant_id],
      );
      await client.query(
        "UPDATE messages SET metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1",
        [messageId,JSON.stringify({ mediaIngestStatus: "ready", mediaAssetId: assetId })],
      );
      await client.query(`INSERT INTO usage_events(
        tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key,metadata
      ) VALUES ($1,$2,$3,$4,'media_ingest',1,'media',$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`, [
        row.tenant_id,row.business_id,row.channel_account_id,row.conversation_id,job.data.correlationId,
        `media-ingest:${messageId}`,JSON.stringify({ messageType: row.message_type }),
      ]);
    });
  } catch (error) {
    await query(
      "UPDATE messages SET metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1",
      [messageId,JSON.stringify({ mediaIngestStatus: "error", mediaIngestError: error instanceof Error ? error.message : "media ingestion failed" })],
    ).catch(() => undefined);
    throw error;
  }
}

async function loadChannelRuntime(channelId: string, conversationId: string) {
  const channel = await query<any>(`
    SELECT ca.*,cv.mode,cv.status AS conversation_status,cv.state_version,ct.external_contact_id
    FROM channel_accounts ca JOIN conversations cv ON cv.channel_account_id=ca.id JOIN contacts ct ON ct.id=cv.contact_id
    WHERE ca.id=$1 AND cv.id=$2
  `, [channelId, conversationId]);
  if (!channel.rows[0]) throw new Error("Channel/conversation context missing");
  const credentials = await query<{ credential_type: string; encrypted_value: string }>("SELECT credential_type,encrypted_value FROM channel_credentials WHERE channel_account_id=$1", [channelId]);
  return { ...channel.rows[0], credentials: Object.fromEntries(credentials.rows.map((row) => [row.credential_type, decryptSecret(row.encrypted_value)])) };
}

async function providerJson(url: string, token: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((json as any)?.error?.message || `Provider returned ${response.status}`);
    (error as any).status = response.status;
    (error as any).body = json;
    throw error;
  }
  return json as any;
}

async function facebookAttachment(tenantId: string, channel: any, asset: any): Promise<string> {
  const cached = await query<{ remote_media_id: string; status: string }>("SELECT remote_media_id,status FROM channel_media_cache WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform=$3", [asset.id, channel.id, channel.platform]);
  if (cached.rows[0]?.status === "valid") return cached.rows[0].remote_media_id;
  const lockKey = redisKey("lock", "remote-media", channel.id, asset.id);
  const lock = await acquireLock(lockKey, 30_000);
  if (!lock) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    const retry = await query<{ remote_media_id: string }>("SELECT remote_media_id FROM channel_media_cache WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform=$3 AND status='valid'", [asset.id, channel.id, channel.platform]);
    if (retry.rows[0]) return retry.rows[0].remote_media_id;
    throw new Error("Remote media refresh is already in progress");
  }
  try {
    const { bytes, mime } = await fetchAssetBytes(tenantId, asset);
    const form = new FormData();
    const type = asset.kind === "video" ? "video" : asset.kind === "audio" ? "audio" : asset.kind === "document" ? "file" : "image";
    form.set("message", JSON.stringify({ attachment: { type, payload: { is_reusable: true } } }));
    form.set("filedata", new Blob([bytes], { type: mime }), asset.original_name || `asset-${asset.id}`);
    const url = `https://graph.facebook.com/${channel.graph_api_version || config.META_GRAPH_API_VERSION}/${encodeURIComponent(channel.external_account_id)}/message_attachments`;
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${channel.credentials.access_token}` }, body: form });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !(json as any).attachment_id) throw new Error((json as any)?.error?.message || `Facebook media upload failed with ${response.status}`);
    const remoteId = (json as any).attachment_id;
    await query(`INSERT INTO channel_media_cache(tenant_id,media_asset_id,channel_account_id,platform,remote_media_id,status,last_used_at)
      VALUES ($1,$2,$3,$4,$5,'valid',now()) ON CONFLICT(media_asset_id,channel_account_id,platform) DO UPDATE SET remote_media_id=EXCLUDED.remote_media_id,status='valid',uploaded_at=now(),last_used_at=now(),failure_metadata='{}'::jsonb`, [tenantId,asset.id,channel.id,channel.platform,remoteId]);
    return remoteId;
  } finally {
    await releaseLock(lockKey, lock);
  }
}

async function whatsappMedia(tenantId: string, channel: any, asset: any): Promise<string> {
  const cached = await query<{ remote_media_id: string; status: string; expires_at: Date | null }>("SELECT remote_media_id,status,expires_at FROM channel_media_cache WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform='whatsapp'", [asset.id,channel.id]);
  if (cached.rows[0]?.status === "valid" && (!cached.rows[0].expires_at || cached.rows[0].expires_at.getTime() > Date.now())) return cached.rows[0].remote_media_id;
  const { bytes, mime } = await fetchAssetBytes(tenantId, asset);
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", mime);
  form.set("file", new Blob([bytes], { type: mime }), asset.original_name || `asset-${asset.id}`);
  const url = `https://graph.facebook.com/${channel.graph_api_version || config.META_GRAPH_API_VERSION}/${encodeURIComponent(channel.external_account_id)}/media`;
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${channel.credentials.access_token}` }, body: form });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !(json as any).id) throw new Error((json as any)?.error?.message || `WhatsApp media upload failed with ${response.status}`);
  const remoteId = (json as any).id;
  await query(`INSERT INTO channel_media_cache(tenant_id,media_asset_id,channel_account_id,platform,remote_media_id,status,last_used_at)
    VALUES ($1,$2,$3,'whatsapp',$4,'valid',now()) ON CONFLICT(media_asset_id,channel_account_id,platform) DO UPDATE SET remote_media_id=EXCLUDED.remote_media_id,status='valid',uploaded_at=now(),last_used_at=now(),failure_metadata='{}'::jsonb`, [tenantId,asset.id,channel.id,remoteId]);
  return remoteId;
}

async function sendProviderMessage(tenantId: string, channel: any, message: any): Promise<{ providerMessageId: string | null }> {
  const token = channel.credentials.access_token;
  if (!token) throw new Error("Channel access token is missing");
  const version = channel.graph_api_version || config.META_GRAPH_API_VERSION;
  if (channel.platform === "facebook") {
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(channel.external_account_id)}/messages`;
    if (message.type === "text") {
      const json = await providerJson(url, token, { recipient: { id: channel.external_contact_id }, messaging_type: "RESPONSE", message: { text: message.text } });
      return { providerMessageId: json.message_id ?? null };
    }
    const asset = await loadAsset(tenantId, message.assetId);
    const attachmentId = await facebookAttachment(tenantId, channel, asset);
    const type = asset.kind === "video" ? "video" : asset.kind === "audio" ? "audio" : asset.kind === "document" ? "file" : "image";
    try {
      const json = await providerJson(url, token, { recipient: { id: channel.external_contact_id }, messaging_type: "RESPONSE", message: { attachment: { type, payload: { attachment_id: attachmentId } } } });
      await query("UPDATE channel_media_cache SET last_used_at=now() WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform='facebook'", [asset.id,channel.id]);
      return { providerMessageId: json.message_id ?? null };
    } catch (error) {
      await query("UPDATE channel_media_cache SET status='stale',failure_metadata=$3::jsonb WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform='facebook'", [asset.id,channel.id,JSON.stringify({ error: error instanceof Error ? error.message : "send failed" })]);
      const fresh = await facebookAttachment(tenantId, channel, asset);
      const json = await providerJson(url, token, { recipient: { id: channel.external_contact_id }, messaging_type: "RESPONSE", message: { attachment: { type, payload: { attachment_id: fresh } } } });
      return { providerMessageId: json.message_id ?? null };
    }
  }

  if (channel.platform === "instagram") {
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(channel.external_account_id)}/messages`;
    if (message.type === "text") {
      const json = await providerJson(url, token, { recipient: { id: channel.external_contact_id }, message: { text: message.text } });
      return { providerMessageId: json.message_id ?? null };
    }
    const asset = await loadAsset(tenantId, message.assetId);
    if (!asset.public_url) throw new Error("Instagram media delivery requires a provider-accessible public media URL");
    const json = await providerJson(url, token, { recipient: { id: channel.external_contact_id }, message: { attachment: { type: asset.kind === "video" ? "video" : "image", payload: { url: asset.public_url } } } });
    return { providerMessageId: json.message_id ?? null };
  }

  if (channel.platform === "whatsapp") {
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(channel.external_account_id)}/messages`;
    if (message.type === "text") {
      const json = await providerJson(url, token, { messaging_product: "whatsapp", to: channel.external_contact_id, type: "text", text: { body: message.text } });
      return { providerMessageId: json.messages?.[0]?.id ?? null };
    }
    const asset = await loadAsset(tenantId, message.assetId);
    const mediaId = await whatsappMedia(tenantId, channel, asset);
    const type = asset.kind === "video" ? "video" : asset.kind === "audio" ? "audio" : asset.kind === "document" ? "document" : "image";
    const json = await providerJson(url, token, { messaging_product: "whatsapp", to: channel.external_contact_id, type, [type]: { id: mediaId, ...(message.caption && ["image","video"].includes(type) ? { caption: message.caption } : {}) } });
    await query("UPDATE channel_media_cache SET last_used_at=now() WHERE media_asset_id=$1 AND channel_account_id=$2 AND platform='whatsapp'", [asset.id,channel.id]);
    return { providerMessageId: json.messages?.[0]?.id ?? null };
  }
  throw new Error(`Unsupported channel platform ${channel.platform}`);
}

async function outboundMessage(job: Job<JobEnvelope<any>>) {
  const { tenantId, businessId, channelAccountId, conversationId, idempotencyKey, correlationId, payload } = job.data;
  if (!businessId || !channelAccountId || !conversationId) throw new Error("Outbound job is missing scope identifiers");
  const existing = await query("SELECT id,delivery_status FROM messages WHERE tenant_id=$1 AND metadata->>'outboundIdempotencyKey'=$2 LIMIT 1", [tenantId,idempotencyKey]);
  if (existing.rows[0]?.delivery_status === "sent") return;
  const channel = await loadChannelRuntime(channelAccountId, conversationId);
  if (!channel.active || channel.connection_status !== "connected" || channel.conversation_status !== "open") throw new Error("Channel or conversation is not active");
  if (payload.senderType === "AI" && channel.mode !== "AI") return;
  const tenant = await query<{ status: string }>("SELECT status FROM tenants WHERE id=$1", [tenantId]);
  if (tenant.rows[0]?.status !== "active") throw new Error("Tenant is not active");

  const customLimit = await query<{ value: string }>("SELECT value::text FROM channel_limit_overrides WHERE channel_account_id=$1 AND key='messagesPerMinute'", [channelAccountId]);
  const perMinute = Math.max(1, Number(customLimit.rows[0]?.value ?? config.OUTBOUND_DEFAULT_RATE_PER_MINUTE));
  const minuteLimit = await rateLimit(redisKey("rate","channel",channelAccountId,"minute"), perMinute, 60_000);
  if (!minuteLimit.allowed) {
    await job.moveToDelayed(Date.now()+minuteLimit.retryAfterMs, job.token!);
    return;
  }
  const burstLimit = await rateLimit(redisKey("rate","channel",channelAccountId,"burst"), config.OUTBOUND_DEFAULT_BURST, 5_000);
  if (!burstLimit.allowed) {
    await job.moveToDelayed(Date.now()+burstLimit.retryAfterMs, job.token!);
    return;
  }

  const message = payload.message;
  const persisted = await query<any>(`
    INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,direction,sender_type,message_type,text_content,delivery_status,metadata)
    VALUES ($1,$2,$3,$4,'OUTBOUND',$5,$6,$7,'sending',$8::jsonb) RETURNING id
  `, [tenantId,businessId,channelAccountId,conversationId,payload.senderType || "AI",message.type,message.type === "text" ? message.text : message.caption ?? null,JSON.stringify({ outboundIdempotencyKey: idempotencyKey, logicalResponseId: payload.logicalResponseId, correlationId })]);
  const messageId = persisted.rows[0].id;
  if (message.type === "media") {
    await query("INSERT INTO message_media(message_id,media_asset_id,tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [messageId,message.assetId,tenantId]);
  }
  try {
    const sent = await sendProviderMessage(tenantId, channel, message);
    await query("UPDATE messages SET platform_message_id=$2,delivery_status='sent',updated_at=now() WHERE id=$1", [messageId,sent.providerMessageId]);
    await query("UPDATE channel_accounts SET last_delivery_at=now(),updated_at=now() WHERE id=$1", [channelAccountId]);
    await query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key,metadata)
      VALUES ($1,$2,$3,$4,'outbound_message',1,'message',$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`, [tenantId,businessId,channelAccountId,conversationId,correlationId,`outbound:${idempotencyKey}`,JSON.stringify({ messageType: message.type, senderType: payload.senderType })]);
    if (message.type === "media") await query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key) VALUES ($1,$2,$3,$4,'media_send',1,'media',$5,$6) ON CONFLICT DO NOTHING`, [tenantId,businessId,channelAccountId,conversationId,correlationId,`media-send:${idempotencyKey}`]);
  } catch (error) {
    await query("UPDATE messages SET delivery_status='failed',metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1", [messageId,JSON.stringify({ error: error instanceof Error ? error.message : "send failed" })]);
    throw error;
  }
}

async function trainingJob(job: Job<JobEnvelope<any>>) {
  const trainingJobId = String(job.data.payload.trainingJobId || job.data.jobId);
  await query("UPDATE training_jobs SET status='running',started_at=now() WHERE id=$1", [trainingJobId]);
  try {
    const result = await internalFetch("/v1/internal/training/synthesize", { method: "POST", body: JSON.stringify({ trainingJobId }) });
    await query("UPDATE training_jobs SET status='completed',candidate_prompt_version_id=$2,evaluation_json=$3::jsonb,cost_metadata=$4::jsonb,completed_at=now() WHERE id=$1", [trainingJobId,result.candidatePromptVersionId,JSON.stringify(result.evaluation ?? {}),JSON.stringify(result.usage ?? {})]);
  } catch (error) {
    await query("UPDATE training_jobs SET status='failed',error=$2,completed_at=now() WHERE id=$1", [trainingJobId,error instanceof Error ? error.message : "training failed"]);
    throw error;
  }
}

async function embeddingJob(job: Job<JobEnvelope<any>>) {
  const sourceId = String(job.data.payload.sourceId);
  const sourceVersion = Number(job.data.payload.sourceVersion);
  await internalFetch("/v1/internal/knowledge/index", { method: "POST", body: JSON.stringify({ sourceId, sourceVersion }) });
}

async function followupJob(job: Job<JobEnvelope<any>>) {
  const followupId = String(job.data.payload.followupId || job.data.jobId);
  const result = await query<any>(`
    SELECT f.*,cv.mode,cv.status AS conversation_status,cv.last_message_at,ca.active,ca.connection_status,t.status AS tenant_status
    FROM followup_jobs f JOIN conversations cv ON cv.id=f.conversation_id JOIN channel_accounts ca ON ca.id=f.channel_account_id JOIN tenants t ON t.id=f.tenant_id
    WHERE f.id=$1
  `,[followupId]);
  const row=result.rows[0];
  if(!row||!["scheduled","queued"].includes(row.status)||row.mode!=="AI"||row.conversation_status!=="open"||!row.active||row.connection_status!=="connected"||row.tenant_status!=="active"){
    if(row) await query("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE id=$1",[followupId]);
    return;
  }
  if (row.last_message_at && new Date(row.last_message_at).getTime() > new Date(row.created_at).getTime()) {
    await query("UPDATE followup_jobs SET status='cancelled',policy_snapshot=policy_snapshot||'{\"cancelled_by_new_activity\":true}'::jsonb,updated_at=now() WHERE id=$1",[followupId]);
    return;
  }
  const maxWindowHours = Math.max(1, Number(row.policy_snapshot?.maxWindowHours ?? 23));
  if (row.last_message_at && Date.now() - new Date(row.last_message_at).getTime() > maxWindowHours * 60 * 60 * 1000) {
    await query("UPDATE followup_jobs SET status='cancelled',policy_snapshot=policy_snapshot||'{\"outside_provider_window\":true}'::jsonb,updated_at=now() WHERE id=$1",[followupId]);
    return;
  }
  const text=String(row.policy_snapshot?.message||"").trim();
  if(!text){await query("UPDATE followup_jobs SET status='cancelled',updated_at=now() WHERE id=$1",[followupId]);return;}
  await internalFetch("/v1/internal/outbound/enqueue",{method:"POST",body:JSON.stringify({tenantId:row.tenant_id,businessId:row.business_id,channelAccountId:row.channel_account_id,conversationId:row.conversation_id,messages:[{type:"text",text}],senderType:"AI",priority:"FOLLOWUP",logicalResponseId:`followup-${followupId}`})});
  await query("UPDATE followup_jobs SET status='sent',updated_at=now() WHERE id=$1",[followupId]);
}

async function analyticsRollup() {
  await query(`
    INSERT INTO usage_rollups(tenant_id,business_id,channel_account_id,bucket_start,bucket_size,event_type,quantity,estimated_cost,updated_at)
    SELECT tenant_id,business_id,channel_account_id,date_trunc('hour',occurred_at),'hour',event_type,SUM(quantity),SUM(COALESCE(estimated_cost,0)),now()
    FROM usage_events WHERE occurred_at>=now()-interval '3 hours'
    GROUP BY tenant_id,business_id,channel_account_id,date_trunc('hour',occurred_at),event_type
    ON CONFLICT(tenant_id,business_id,channel_account_id,bucket_start,bucket_size,event_type)
    DO UPDATE SET quantity=EXCLUDED.quantity,estimated_cost=EXCLUDED.estimated_cost,updated_at=now()
  `);
}


async function dispatchOutboxBatch(limit = 100) {
  const events = await transaction(async (client) => {
    const selected = await client.query<any>(`
      SELECT * FROM outbox_events
      WHERE status IN ('pending','failed') AND next_attempt_at<=now()
      ORDER BY created_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [limit]);
    if (!selected.rows.length) return [];
    await client.query(
      "UPDATE outbox_events SET status='dispatching',attempt_count=attempt_count+1 WHERE id=ANY($1::uuid[])",
      [selected.rows.map((row) => row.id)],
    );
    return selected.rows;
  });

  for (const event of events) {
    try {
      if (config.N8N_HEALTH_WEBHOOK_URL && ["CHANNEL_CONNECTED","CHANNEL_DISCONNECTED"].includes(event.event_type)) {
        // Infrastructure-specific integration hooks can subscribe through the existing n8n runtime.
        const response = await fetch(config.N8N_HEALTH_WEBHOOK_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.INTERNAL_SERVICE_AUTH_SECRET}` },
          body: JSON.stringify({ kind: "domain_event", event }),
        });
        if (!response.ok && response.status !== 404 && response.status !== 405) {
          throw new Error(`n8n event hook returned ${response.status}`);
        }
      }

      if (event.event_type === "AGENT_PROMPT_PUBLISHED") {
        await redis().del(redisKey("cache","agent",String(event.resource_id)));
      }
      if (event.event_type === "CHANNEL_SETTINGS_CHANGED" || event.event_type === "CHANNEL_CONNECTED" || event.event_type === "CHANNEL_DISCONNECTED") {
        await redis().del(redisKey("cache","channel",String(event.resource_id)));
      }
      if (event.event_type === "COLLECTION_SCHEMA_CHANGED") {
        await redis().del(redisKey("cache","collection",String(event.resource_id)));
      }

      await query("UPDATE outbox_events SET status='dispatched',dispatched_at=now() WHERE id=$1", [event.id]);
    } catch (error) {
      const attempt = Number(event.attempt_count ?? 0) + 1;
      const delaySeconds = Math.min(3600, Math.max(5, 2 ** Math.min(attempt, 10)));
      await query(
        "UPDATE outbox_events SET status='failed',next_attempt_at=now()+($2 || ' seconds')::interval,payload=payload||$3::jsonb WHERE id=$1",
        [event.id,String(delaySeconds),JSON.stringify({ lastDispatchError: error instanceof Error ? error.message : "dispatch failed" })],
      );
    }
  }
  return events.length;
}

async function scheduleDueFollowups(limit = 100) {
  const due = await transaction(async (client) => {
    const selected = await client.query<any>(`
      SELECT id,tenant_id,business_id,channel_account_id,conversation_id
      FROM followup_jobs
      WHERE status='scheduled' AND due_at<=now()
      ORDER BY due_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [limit]);
    if (!selected.rows.length) return [];
    await client.query("UPDATE followup_jobs SET status='queued',updated_at=now() WHERE id=ANY($1::uuid[])", [selected.rows.map((row) => row.id)]);
    return selected.rows;
  });
  for (const row of due) {
    const jobId = `followup:${row.id}`;
    try {
      const { queue } = await import("@n8n-automation/core");
      await queue(QUEUES.followups).add("SEND_FOLLOWUP", {
        jobId,
        jobType: "SEND_FOLLOWUP",
        tenantId: row.tenant_id,
        businessId: row.business_id,
        channelAccountId: row.channel_account_id,
        conversationId: row.conversation_id,
        correlationId: jobId,
        idempotencyKey: jobId,
        createdAt: new Date().toISOString(),
        payload: { followupId: row.id },
      }, { jobId });
    } catch (error) {
      await query("UPDATE followup_jobs SET status='scheduled',updated_at=now() WHERE id=$1 AND status='queued'", [row.id]).catch(() => undefined);
      throw error;
    }
  }
  return due.length;
}

function makeWorker(name: string, handler: (job: Job<any>) => Promise<any>, concurrency = config.WORKER_CONCURRENCY) {
  const worker = new Worker(name, handler, { connection: redis(), prefix: config.QUEUE_PREFIX, concurrency });
  worker.on("completed", (job) => log("job_completed", { queue: name, jobId: job.id, jobName: job.name }));
  worker.on("failed", (job, error) => log("job_failed", { queue: name, jobId: job?.id, jobName: job?.name, error: error.message }));
  worker.on("error", (error) => log("worker_error", { queue: name, error: error.message }));
  workers.push(worker);
}

makeWorker(QUEUES.inbound, aggregateConversation);
makeWorker(QUEUES.outbound, outboundMessage, Math.max(2, config.WORKER_CONCURRENCY));
makeWorker(QUEUES.media, uploadInboundMedia, Math.max(1, Math.ceil(config.WORKER_CONCURRENCY/2)));
makeWorker(QUEUES.training, trainingJob, Math.max(1, Math.ceil(config.WORKER_CONCURRENCY/4)));
makeWorker(QUEUES.embeddings, embeddingJob, Math.max(1, Math.ceil(config.WORKER_CONCURRENCY/3)));
makeWorker(QUEUES.followups, followupJob, Math.max(1, Math.ceil(config.WORKER_CONCURRENCY/2)));
makeWorker(QUEUES.analytics, async () => analyticsRollup(), 1);
makeWorker(QUEUES.maintenance, async (job) => {
  if(job.name==="ANALYTICS_ROLLUP") return analyticsRollup();
  if(job.name==="CLEAN_EXPIRED_SESSIONS") return query("DELETE FROM sessions WHERE expires_at<now() OR revoked_at<now()-interval '30 days'");
  if(job.name==="CLEAN_IDEMPOTENCY") return query("DELETE FROM idempotency_keys WHERE expires_at IS NOT NULL AND expires_at<now()");
},1);

// Lightweight periodic durable maintenance. Queue-based jobs remain the canonical long-running path.
const timer=setInterval(()=>{
  void analyticsRollup().catch((error)=>log("analytics_rollup_error",{error:error instanceof Error?error.message:"error"}));
},15*60*1000);
timer.unref();

const outboxTimer=setInterval(()=>{
  void dispatchOutboxBatch().catch((error)=>log("outbox_dispatch_error",{error:error instanceof Error?error.message:"error"}));
},2_000);
outboxTimer.unref();

const followupTimer=setInterval(()=>{
  void scheduleDueFollowups().catch((error)=>log("followup_schedule_error",{error:error instanceof Error?error.message:"error"}));
},5_000);
followupTimer.unref();

void dispatchOutboxBatch().catch((error)=>log("outbox_dispatch_error",{error:error instanceof Error?error.message:"error"}));
void scheduleDueFollowups().catch((error)=>log("followup_schedule_error",{error:error instanceof Error?error.message:"error"}));

log("worker_started", { queues: workers.map((worker)=>worker.name), concurrency: config.WORKER_CONCURRENCY });

async function shutdown(signal:string){
  log("worker_shutdown",{signal});
  clearInterval(timer);
  clearInterval(outboxTimer);
  clearInterval(followupTimer);
  await Promise.all(workers.map((worker)=>worker.close()));
  process.exit(0);
}
process.on("SIGTERM",()=>void shutdown("SIGTERM"));
process.on("SIGINT",()=>void shutdown("SIGINT"));
