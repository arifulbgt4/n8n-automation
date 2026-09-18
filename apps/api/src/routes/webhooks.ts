import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  enqueue,
  env,
  query,
  QUEUES,
  randomToken,
  sha256,
  transaction,
  type NormalizedInboundMessage,
} from "@n8n-automation/core";
import { ApiError, requestId } from "../lib.js";

function verifyMetaSignature(request: FastifyRequest): boolean {
  const secret = env().META_APP_SECRET;
  if (!secret) return env().NODE_ENV !== "production";
  const signature = request.headers["x-hub-signature-256"] as string | undefined;
  const raw = (request as any).rawBody as Buffer | undefined;
  if (!signature || !raw) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeMetaPayload(payload: any): NormalizedInboundMessage[] {
  const messages: NormalizedInboundMessage[] = [];
  if (payload?.object === "whatsapp_business_account") {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const channelExternalId = String(value.metadata?.phone_number_id ?? "");
        for (const message of value.messages ?? []) {
          const type = String(message.type ?? "unknown") as NormalizedInboundMessage["type"];
          const mediaNode = message.image ?? message.audio ?? message.video ?? message.document ?? null;
          messages.push({
            platform: "whatsapp",
            channelExternalId,
            eventId: String(message.id ?? `${entry.id}:${message.timestamp}:${message.from}`),
            messageId: String(message.id ?? randomToken(12)),
            senderExternalId: String(message.from ?? ""),
            type: ["text","image","audio","video","document","reaction"].includes(type) ? type : "unknown",
            text: message.text?.body ?? message.image?.caption ?? message.video?.caption ?? message.document?.caption ?? null,
            providerMediaId: mediaNode?.id ?? null,
            providerTimestamp: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : null,
            metadata: {
              rawType: message.type,
              context: message.context ?? null,
              providerMimeType: mediaNode?.mime_type ?? null,
              providerFilename: message.document?.filename ?? null,
            },
          });
        }
      }
    }
    return messages.filter((message) => message.channelExternalId && message.senderExternalId);
  }

  if (payload?.object === "page" || payload?.object === "instagram") {
    const platform = payload.object === "instagram" ? "instagram" : "facebook";
    for (const entry of payload.entry ?? []) {
      for (const event of entry.messaging ?? []) {
        if (!event.message) continue;
        const attachment = event.message.attachments?.[0];
        let type: NormalizedInboundMessage["type"] = "text";
        if (attachment?.type === "image") type = "image";
        else if (attachment?.type === "audio") type = "audio";
        else if (attachment?.type === "video") type = "video";
        else if (attachment?.type === "file") type = "document";
        messages.push({
          platform,
          channelExternalId: String(event.recipient?.id ?? entry.id ?? ""),
          eventId: String(event.message.mid ?? `${entry.id}:${event.timestamp}:${event.sender?.id}`),
          messageId: String(event.message.mid ?? randomToken(12)),
          senderExternalId: String(event.sender?.id ?? ""),
          type,
          text: event.message.text ?? attachment?.payload?.title ?? null,
          providerMediaUrl: attachment?.payload?.url ?? null,
          providerTimestamp: event.timestamp ? new Date(Number(event.timestamp)).toISOString() : null,
          metadata: {
            isEcho: Boolean(event.message.is_echo),
            appId: event.message.app_id ?? null,
            attachments: event.message.attachments ?? [],
            replyTo: event.message.reply_to?.mid ?? null,
            recipientId: event.recipient?.id ?? null,
            providerFilename: attachment?.payload?.title ?? null,
          },
        });
      }
    }
  }
  return messages.filter((message) => message.channelExternalId && message.senderExternalId);
}

async function resolveChannel(message: NormalizedInboundMessage) {
  const result = await query<any>(`
    SELECT c.*, b.status AS business_status, t.status AS tenant_status
    FROM channel_accounts c
    JOIN businesses b ON b.id=c.business_id
    JOIN tenants t ON t.id=c.tenant_id
    WHERE c.platform=$1 AND c.external_account_id=$2 AND c.active=true
    LIMIT 1
  `, [message.platform, message.channelExternalId]);
  return result.rows[0] ?? null;
}

async function ingestOne(message: NormalizedInboundMessage, correlationId: string) {
  const channel = await resolveChannel(message);
  if (!channel || channel.connection_status === "disconnected" || channel.tenant_status !== "active" || channel.business_status !== "active") {
    return { accepted: false, reason: "channel_not_active" };
  }

  const isEcho = Boolean((message.metadata as any)?.isEcho);
  if (isEcho) {
    const knownOutbound = await query("SELECT id,conversation_id FROM messages WHERE channel_account_id=$1 AND platform_message_id=$2 AND direction='OUTBOUND'", [channel.id, message.messageId]);
    if (knownOutbound.rows[0]) return { accepted: true, duplicateEcho: true };
    const contactId = String((message.metadata as any)?.recipientId ?? message.senderExternalId);
    const conversation = await query<any>(`
      SELECT cv.id,cv.contact_id,cv.agent_profile_id
      FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id
      WHERE cv.channel_account_id=$1 AND cv.status='open'
      ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1
    `, [channel.id]);
    if (conversation.rows[0]) {
      await transaction(async (client) => {
        await client.query("UPDATE conversations SET mode='HUMAN',state_version=state_version+1,updated_at=now() WHERE id=$1", [conversation.rows[0].id]);
        await client.query(`INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,platform_message_id,platform_event_id,direction,sender_type,message_type,text_content,provider_timestamp,delivery_status,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,'OUTBOUND','HUMAN',$7,$8,$9,'sent',$10::jsonb) ON CONFLICT DO NOTHING`, [channel.tenant_id, channel.business_id, channel.id, conversation.rows[0].id, message.messageId, message.eventId, message.type, message.text ?? null, message.providerTimestamp ?? null, JSON.stringify(message.metadata ?? {})]);
        const lastTrainer = await client.query<any>(`
          SELECT m.text_content,m.id,ti.agent_profile_id
          FROM messages m
          JOIN trainer_identities ti ON ti.channel_account_id=m.channel_account_id AND ti.tenant_id=m.tenant_id AND ti.active=true
          WHERE m.conversation_id=$1 AND m.sender_type='TRAINER' AND m.text_content IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1
        `, [conversation.rows[0].id]);
        if (lastTrainer.rows[0] && message.text) {
          await client.query(`INSERT INTO training_examples(tenant_id,agent_profile_id,source,input_text,ideal_response,input_json,labels,approval_status)
            VALUES ($1,$2,'channel_demonstration',$3,$4,$5::jsonb,ARRAY['channel_training'],'pending')`, [channel.tenant_id, lastTrainer.rows[0].agent_profile_id ?? conversation.rows[0].agent_profile_id, lastTrainer.rows[0].text_content, message.text, JSON.stringify({ conversationId: conversation.rows[0].id, inputMessageId: lastTrainer.rows[0].id })]);
        }
      });
      return { accepted: true, manualHuman: true };
    }
    return { accepted: true, manualHuman: true, conversationMissing: true, contactId };
  }

  const trainer = await query<{ id: string; agent_profile_id: string | null }>(`
    SELECT id,agent_profile_id FROM trainer_identities
    WHERE tenant_id=$1 AND active=true
      AND (channel_account_id=$2 OR channel_account_id IS NULL)
      AND identifier_hash=$3
    ORDER BY (channel_account_id IS NOT NULL) DESC LIMIT 1
  `, [channel.tenant_id, channel.id, sha256(message.senderExternalId)]);
  const senderType = trainer.rows[0] ? "TRAINER" : "CONTACT";

  const created = await transaction(async (client) => {
    const duplicate = await client.query("SELECT id,conversation_id FROM messages WHERE channel_account_id=$1 AND platform_message_id=$2", [channel.id, message.messageId]);
    if (duplicate.rows[0]) return { duplicate: true, messageId: duplicate.rows[0].id, conversationId: duplicate.rows[0].conversation_id };
    let contact = await client.query<{ id: string }>("SELECT id FROM contacts WHERE channel_account_id=$1 AND external_contact_id=$2", [channel.id, message.senderExternalId]);
    if (!contact.rows[0]) {
      contact = await client.query<{ id: string }>(`INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [channel.tenant_id, channel.business_id, channel.id, message.senderExternalId]);
    }
    let conversation = await client.query<any>(`SELECT id,mode,agent_profile_id FROM conversations WHERE channel_account_id=$1 AND contact_id=$2 AND status='open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [channel.id, contact.rows[0].id]);
    if (!conversation.rows[0]) {
      conversation = await client.query<any>(`
        INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id,last_message_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING id,mode,agent_profile_id
      `, [channel.tenant_id, channel.business_id, channel.id, contact.rows[0].id, senderType === "TRAINER" ? "PAUSED" : "AI", trainer.rows[0]?.agent_profile_id ?? channel.default_agent_profile_id ?? null]);
    }
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,platform_message_id,platform_event_id,direction,sender_type,message_type,text_content,provider_timestamp,delivery_status,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'INBOUND',$7,$8,$9,$10,'received',$11::jsonb)
      RETURNING id
    `, [channel.tenant_id, channel.business_id, channel.id, conversation.rows[0].id, message.messageId, message.eventId, senderType, message.type, message.text ?? null, message.providerTimestamp ?? null, JSON.stringify({
      ...message.metadata,
      providerMediaId: message.providerMediaId,
      providerMediaUrl: message.providerMediaUrl,
      mediaIngestStatus: ["image","audio","video","document"].includes(message.type) ? "pending" : "none",
    })]);
    await client.query("UPDATE conversations SET last_message_at=now(),updated_at=now() WHERE id=$1", [conversation.rows[0].id]);
    if (senderType === "CONTACT") {
      await client.query(
        "UPDATE followup_jobs SET status='cancelled',policy_snapshot=policy_snapshot||'{\"cancelled_by_inbound\":true}'::jsonb,updated_at=now() WHERE conversation_id=$1 AND status IN ('scheduled','queued')",
        [conversation.rows[0].id],
      );
    }
    await client.query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key)
      VALUES ($1,$2,$3,$4,'inbound_message',1,'message',$5,$6) ON CONFLICT DO NOTHING`, [channel.tenant_id, channel.business_id, channel.id, conversation.rows[0].id, correlationId, `inbound:${message.messageId}`]);
    return { duplicate: false, messageId: inserted.rows[0].id, conversationId: conversation.rows[0].id, mode: conversation.rows[0].mode, senderType };
  });

  if (!created.duplicate && ["image","audio","video","document"].includes(message.type) && (message.providerMediaId || message.providerMediaUrl)) {
    const mediaJobId = `media:inbound:${created.messageId}`;
    await enqueue(QUEUES.media, {
      jobId: mediaJobId,
      jobType: "INGEST_INBOUND_MEDIA",
      tenantId: channel.tenant_id,
      businessId: channel.business_id,
      channelAccountId: channel.id,
      conversationId: created.conversationId,
      correlationId,
      idempotencyKey: mediaJobId,
      createdAt: new Date().toISOString(),
      payload: { messageId: created.messageId },
    });
  }

  if (!created.duplicate && created.senderType !== "TRAINER" && created.mode === "AI") {
    const jobId = `inbound:${created.conversationId}:${message.messageId}`;
    await enqueue(QUEUES.inbound, {
      jobId,
      jobType: "AGGREGATE_CONVERSATION",
      tenantId: channel.tenant_id,
      businessId: channel.business_id,
      channelAccountId: channel.id,
      conversationId: created.conversationId,
      correlationId,
      idempotencyKey: jobId,
      createdAt: new Date().toISOString(),
      payload: { messageId: created.messageId },
    }, { delay: env().AGGREGATION_WINDOW_MS });
  }
  return { accepted: true, ...created };
}

export async function webhookRoutes(app: FastifyInstance) {
  app.get("/webhooks/meta", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === env().META_VERIFY_TOKEN && q["hub.challenge"]) {
      return reply.type("text/plain").send(q["hub.challenge"]);
    }
    return reply.code(403).send("Forbidden");
  });

  app.post("/webhooks/meta", async (request, reply) => {
    if (!verifyMetaSignature(request)) throw new ApiError(401, "WEBHOOK_SIGNATURE_INVALID", "Meta webhook signature is invalid.");
    const correlationId = requestId(request);
    const normalized = normalizeMetaPayload(request.body);
    const results = [];
    for (const message of normalized) results.push(await ingestOne(message, correlationId));
    reply.code(200).send({ ok: true, received: normalized.length, results });
  });

  app.post("/v1/internal/meta/events", async (request, reply) => {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!auth || auth !== env().INTERNAL_SERVICE_AUTH_SECRET) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Unauthorized.");
    const correlationId = requestId(request);
    const normalized = normalizeMetaPayload(request.body);
    const results = [];
    for (const message of normalized) results.push(await ingestOne(message, correlationId));
    reply.send({ ok: true, received: normalized.length, results });
  });
}
