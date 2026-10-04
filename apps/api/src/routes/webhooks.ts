import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  enqueue,
  env,
  query,
  QUEUES,
  randomToken,
  transaction,
  type NormalizedInboundMessage,
} from "@n8n-automation/core";
import { ApiError, requestId, safeSecretEqual } from "../lib.js";
import { isNativeHumanReply } from "../native-training-capability.js";
import { captureTrainingMessage } from "../training-session.js";

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

async function applyProviderDeliveryEvents(payload:any,correlationId:string){
  if(payload?.object==="whatsapp_business_account"){
    for(const entry of payload.entry??[]){
      for(const change of entry.changes??[]){
        const channelExternalId = String(change.value?.metadata?.phone_number_id ?? "");
        const channel = channelExternalId
          ? await query<{ id: string }>("SELECT id FROM channel_accounts WHERE platform='whatsapp' AND external_account_id=$1", [channelExternalId])
          : { rows: [] as Array<{ id: string }> };
        if (!channel.rows[0]) continue;
        for(const status of change.value?.statuses??[]){
          const providerId=String(status.id??"");if(!providerId)continue;
          const mapped=status.status==="read"?"read":status.status==="delivered"?"delivered":status.status==="sent"?"sent":status.status==="failed"?"failed":String(status.status||"sent");
          const updated=await query<any>(`
            UPDATE messages SET delivery_status=$2,metadata=metadata||$3::jsonb,updated_at=now()
            WHERE platform_message_id=$1 AND channel_account_id=$4 AND direction='OUTBOUND'
            RETURNING tenant_id,business_id,channel_account_id,conversation_id,id
          `,[providerId,mapped,JSON.stringify({providerStatus:status.status,providerStatusAt:status.timestamp?new Date(Number(status.timestamp)*1000).toISOString():null,providerErrors:status.errors??null}),channel.rows[0].id]);
          for(const row of updated.rows){
            await query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key,metadata)
              VALUES ($1,$2,$3,$4,'delivery_status',1,'event',$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
              [row.tenant_id,row.business_id,row.channel_account_id,row.conversation_id,correlationId,`delivery:${providerId}:${mapped}`,JSON.stringify({messageId:row.id,status:mapped})]);
          }
        }
      }
    }
    return;
  }
  if(payload?.object==="page"||payload?.object==="instagram"){
    const platform=payload.object==="instagram"?"instagram":"facebook";
    for(const entry of payload.entry??[]){
      for(const event of entry.messaging??[]){
        const receivingId=String(event.recipient?.id??entry.id??"");
        if(!receivingId)continue;
        const channel=await query<any>("SELECT id,tenant_id,business_id FROM channel_accounts WHERE platform=$1 AND external_account_id=$2",[platform,receivingId]);
        if(!channel.rows[0])continue;
        if(event.delivery?.mids?.length){
          await query("UPDATE messages SET delivery_status='delivered',metadata=metadata||$3::jsonb,updated_at=now() WHERE tenant_id=$4 AND channel_account_id=$1 AND platform_message_id=ANY($2::text[]) AND direction='OUTBOUND'",
            [channel.rows[0].id,event.delivery.mids,JSON.stringify({deliveredAt:event.delivery.watermark?new Date(Number(event.delivery.watermark)).toISOString():null}),channel.rows[0].tenant_id]);
        }
        if(event.read?.watermark){
          const contact=await query<any>("SELECT id FROM contacts WHERE channel_account_id=$1 AND external_contact_id=$2",[channel.rows[0].id,String(event.sender?.id??"")]);
          if(contact.rows[0]){
            await query(`
              UPDATE messages m SET delivery_status='read',metadata=metadata||$3::jsonb,updated_at=now()
              FROM conversations cv
              WHERE m.tenant_id=$5 AND cv.tenant_id=$5 AND m.conversation_id=cv.id AND cv.contact_id=$1 AND m.channel_account_id=$2 AND m.direction='OUTBOUND'
                AND m.created_at<=to_timestamp($4::double precision/1000.0) AND m.delivery_status IN ('sent','delivered')
            `,[contact.rows[0].id,channel.rows[0].id,JSON.stringify({readAt:new Date(Number(event.read.watermark)).toISOString()}),Number(event.read.watermark),channel.rows[0].tenant_id]);
          }
        }
      }
    }
  }
}

export function normalizeMetaPayload(payload: any): NormalizedInboundMessage[] {
  const messages: NormalizedInboundMessage[] = [];
  if (payload?.object === "whatsapp_business_account") {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const channelExternalId = String(value.metadata?.phone_number_id ?? "");
        for (const message of value.messages ?? []) {
          const type = String(message.type ?? "unknown") as NormalizedInboundMessage["type"];
          const mediaNode = message.image ?? message.audio ?? message.video ?? message.document ?? null;
          const contactProfile = (value.contacts ?? []).find((contact: any) => String(contact.wa_id ?? "") === String(message.from ?? ""))?.profile;
          messages.push({
            platform: "whatsapp",
            channelExternalId,
            eventId: String(message.id ?? `${entry.id}:${message.timestamp}:${message.from}`),
            messageId: String(message.id ?? randomToken(12)),
            senderExternalId: String(message.from ?? ""),
            senderDisplayName: typeof contactProfile?.name === "string" ? contactProfile.name.trim() || null : null,
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
        if (change.field === "smb_message_echoes") {
          for (const echo of value.message_echoes ?? []) {
            if (["edit","revoke"].includes(String(echo.type))) continue;
            const mediaNode = echo.image ?? echo.audio ?? echo.video ?? echo.document ?? null;
            const type = String(echo.type ?? "unknown") as NormalizedInboundMessage["type"];
            messages.push({
              platform: "whatsapp",channelExternalId,
              eventId:String(echo.id ?? randomToken(12)),messageId:String(echo.id ?? randomToken(12)),
              senderExternalId:String(echo.to ?? "").replace(/^\+/, ""),
              type:["text","image","audio","video","document"].includes(type)?type:"unknown",
              text:echo.text?.body ?? mediaNode?.caption ?? null,
              providerTimestamp:echo.timestamp?new Date(Number(echo.timestamp)*1000).toISOString():null,
              metadata:{isEcho:true,echoSource:"smb_message_echoes",recipientId:String(echo.to??"").replace(/^\+/, ""),rawType:echo.type},
            });
          }
        }
      }
    }
    return messages.filter((message) => message.channelExternalId && message.senderExternalId);
  }

  if (payload?.object === "page" || payload?.object === "instagram") {
    const platform = payload.object === "instagram" ? "instagram" : "facebook";
    for (const entry of payload.entry ?? []) {
      for (const event of [...(entry.messaging ?? []),...(entry.standby ?? [])]) {
        if (!event.message) continue;
        const isEcho = Boolean(event.message.is_echo);
        const attachments = Array.isArray(event.message.attachments) ? event.message.attachments : [];
        const normalizedAttachments = attachments.length ? attachments : [null];
        const originalEventId = String(event.message.mid ?? `${entry.id}:${event.timestamp}:${event.sender?.id}`);
        const originalMessageId = String(event.message.mid ?? originalEventId);
        const hasMultipleAttachments = attachments.length > 1;
        for (const [attachmentIndex, attachment] of normalizedAttachments.entries()) {
          let type: NormalizedInboundMessage["type"] = "text";
          if (attachment?.type === "image") type = "image";
          else if (attachment?.type === "audio") type = "audio";
          else if (attachment?.type === "video") type = "video";
          else if (attachment?.type === "file") type = "document";
          messages.push({
            platform,
            channelExternalId: String((isEcho ? event.sender?.id : event.recipient?.id) ?? entry.id ?? ""),
            eventId: hasMultipleAttachments ? `${originalEventId}:attachment:${attachmentIndex}` : originalEventId,
            messageId: hasMultipleAttachments ? `${originalMessageId}:attachment:${attachmentIndex}` : String(event.message.mid ?? randomToken(12)),
            senderExternalId: String((isEcho ? event.recipient?.id : event.sender?.id) ?? ""),
            type,
            text: attachmentIndex === 0 ? event.message.text ?? attachment?.payload?.title ?? null : null,
            providerMediaUrl: attachment?.payload?.url ?? null,
            providerTimestamp: event.timestamp ? new Date(Number(event.timestamp)).toISOString() : null,
            metadata: {
              isEcho,
              appId: event.message.app_id ?? null,
              attachments,
              replyTo: event.message.reply_to?.mid ?? null,
              recipientId: event.recipient?.id ?? null,
              providerFilename: attachment?.payload?.title ?? null,
              ...(hasMultipleAttachments ? {
                originalMessageId,
                attachmentIndex,
                attachmentCount: attachments.length,
              } : {}),
            },
          });
        }
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
    if (!isNativeHumanReply(message)) return { accepted: true, ignoredEcho: true };
    const recordedTrainingEcho = await query("SELECT id FROM training_session_messages WHERE channel_account_id=$1 AND platform_message_id=$2 AND direction='HUMAN' LIMIT 1",[channel.id,message.messageId]);
    if (recordedTrainingEcho.rows[0]) return { accepted:true,duplicateTrainingEcho:true };
    const contactId = message.senderExternalId;
    return transaction(async (client) => {
      // Serialize webhook classification with Training ON and AI provider sends.
      await client.query("SELECT id FROM channel_accounts WHERE id=$1 FOR UPDATE",[channel.id]);
      const contact = await client.query<{id:string}>(`INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(channel_account_id,external_contact_id)
        DO UPDATE SET updated_at=contacts.updated_at RETURNING id`,
        [channel.tenant_id,channel.business_id,channel.id,contactId]);
      const inTraining = await client.query(`SELECT id FROM training_sessions
        WHERE tenant_id=$1 AND channel_account_id=$2 AND
          $3::timestamptz IS NOT NULL AND created_at<=$3::timestamptz
          AND (stopped_at IS NULL OR date_trunc('milliseconds',stopped_at)>$3::timestamptz)
        LIMIT 1`,[channel.tenant_id,channel.id,message.providerTimestamp??null]);
      const heldTraining = await client.query<{id:string}>(
        "SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open' LIMIT 1",[channel.id]);
      let conversation = await client.query<{id:string}>(`SELECT id FROM conversations
        WHERE channel_account_id=$1 AND contact_id=$2 AND status='open'
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[channel.id,contact.rows[0].id]);
      if (!conversation.rows[0]) {
        conversation = await client.query<{id:string}>(`INSERT INTO conversations(
          tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id,escalation_metadata,last_message_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now()) RETURNING id`,
          [channel.tenant_id,channel.business_id,channel.id,contact.rows[0].id,
            heldTraining.rows[0]||!inTraining.rows[0]?"HUMAN":"AI",channel.default_agent_profile_id??null,
            JSON.stringify(heldTraining.rows[0]&&inTraining.rows[0]?{trainingAutoHumanSessionId:heldTraining.rows[0].id}:{})]);
      }
      const conversationId=conversation.rows[0].id;
      const inserted = await client.query<{id:string}>(`INSERT INTO messages(
        tenant_id,business_id,channel_account_id,conversation_id,platform_message_id,platform_event_id,
        direction,sender_type,message_type,text_content,provider_timestamp,delivery_status,metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,'OUTBOUND','HUMAN',$7,$8,$9,'sent',$10::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`,
        [channel.tenant_id,channel.business_id,channel.id,conversationId,message.messageId,message.eventId,
          message.type,message.text??null,message.providerTimestamp??null,JSON.stringify(message.metadata??{})]);
      if (!inserted.rows[0]) return {accepted:true,duplicateEcho:true};
      await captureTrainingMessage(client,{
        tenantId:channel.tenant_id,businessId:channel.business_id,channelId:channel.id,
        conversationId,sourceMessageId:inserted.rows[0].id,
        platformMessageId:message.messageId,direction:"HUMAN",text:message.text,providerTimestamp:message.providerTimestamp,
      });
      if (!inTraining.rows[0]) {
        await client.query("UPDATE conversations SET mode='HUMAN',escalation_metadata=escalation_metadata-'trainingAutoHumanSessionId',state_version=state_version+1,updated_at=now() WHERE id=$1",[conversationId]);
      }
      return {accepted:true,manualHuman:true};
    });
  }

  const recordedTrainingMessage = await query("SELECT id FROM training_session_messages WHERE channel_account_id=$1 AND platform_message_id=$2 AND direction='CONTACT' LIMIT 1",[channel.id,message.messageId]);
  if (recordedTrainingMessage.rows[0]) return { accepted:true,duplicateTrainingMessage:true };

  const senderType = "CONTACT";

  const created = await transaction(async (client) => {
    await client.query("SELECT id FROM channel_accounts WHERE id=$1 FOR UPDATE",[channel.id]);
    const heldTraining = await client.query<{id:string}>(
        "SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open' LIMIT 1",[channel.id]);
    const contact = await client.query<{ id: string; display_name: string | null }>(`INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id,display_name)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(channel_account_id,external_contact_id)
      DO UPDATE SET display_name=COALESCE(NULLIF(EXCLUDED.display_name,''),contacts.display_name) RETURNING id,display_name`,
      [channel.tenant_id, channel.business_id, channel.id, message.senderExternalId, message.senderDisplayName ?? null]);
    const duplicate = await client.query("SELECT id,conversation_id FROM messages WHERE channel_account_id=$1 AND platform_message_id=$2", [channel.id, message.messageId]);
    if (duplicate.rows[0]) return { duplicate: true, messageId: duplicate.rows[0].id, conversationId: duplicate.rows[0].conversation_id };
    let conversation = await client.query<any>(`SELECT id,mode,agent_profile_id FROM conversations WHERE channel_account_id=$1 AND contact_id=$2 AND status='open' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [channel.id, contact.rows[0].id]);
    if (!conversation.rows[0]) {
      conversation = await client.query<any>(`
        INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id,escalation_metadata,last_message_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now()) RETURNING id,mode,agent_profile_id
      `, [channel.tenant_id, channel.business_id, channel.id, contact.rows[0].id,
        heldTraining.rows[0]?"HUMAN":"AI", channel.default_agent_profile_id ?? null,
        JSON.stringify(heldTraining.rows[0]?{trainingAutoHumanSessionId:heldTraining.rows[0].id}:{})]);
    } else if (heldTraining.rows[0] && conversation.rows[0].mode === "AI") {
      conversation = await client.query<any>(`
        UPDATE conversations SET mode='HUMAN',state_version=state_version+1,
          escalation_metadata=escalation_metadata||jsonb_build_object('trainingAutoHumanSessionId',$2::text),updated_at=now()
        WHERE id=$1 RETURNING id,mode,agent_profile_id
      `,[conversation.rows[0].id,heldTraining.rows[0].id]);
    }
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,platform_message_id,platform_event_id,direction,sender_type,message_type,text_content,provider_timestamp,delivery_status,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'INBOUND',$7,$8,$9,$10,'received',$11::jsonb)
      ON CONFLICT DO NOTHING RETURNING id
    `, [channel.tenant_id, channel.business_id, channel.id, conversation.rows[0].id, message.messageId, message.eventId, senderType, message.type, message.text ?? null, message.providerTimestamp ?? null, JSON.stringify({
      ...message.metadata,
      providerMediaId: message.providerMediaId,
      providerMediaUrl: message.providerMediaUrl,
      mediaIngestStatus: ["image","audio","video","document"].includes(message.type) ? "pending" : "none",
    })]);
    if (!inserted.rows[0]) return { duplicate: true, messageId: null, conversationId: conversation.rows[0].id };
    await client.query("UPDATE conversations SET last_message_at=now(),updated_at=now() WHERE id=$1", [conversation.rows[0].id]);
    const trainingCaptured = await captureTrainingMessage(client,{
      tenantId:channel.tenant_id,businessId:channel.business_id,channelId:channel.id,
      conversationId:conversation.rows[0].id,sourceMessageId:inserted.rows[0].id,
      platformMessageId:message.messageId,direction:"CONTACT",text:message.text,providerTimestamp:message.providerTimestamp,
    });
    let trainingSuppressed = false;
    if (!trainingCaptured) {
      const activeTraining = await client.query("SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open' LIMIT 1",[channel.id]);
      trainingSuppressed = Boolean(activeTraining.rows[0]);
      if (trainingSuppressed) await client.query(`UPDATE messages SET metadata=metadata||'{"trainingSuppressed":true}'::jsonb WHERE id=$1`,[inserted.rows[0].id]);
    }
    if (senderType === "CONTACT") {
      await client.query(
        "UPDATE followup_jobs SET status='cancelled',policy_snapshot=policy_snapshot||'{\"cancelled_by_inbound\":true}'::jsonb,updated_at=now() WHERE conversation_id=$1 AND status IN ('scheduled','queued')",
        [conversation.rows[0].id],
      );
    }
    await client.query(`INSERT INTO usage_events(tenant_id,business_id,channel_account_id,conversation_id,event_type,quantity,unit,correlation_id,idempotency_key)
      VALUES ($1,$2,$3,$4,'inbound_message',1,'message',$5,$6) ON CONFLICT DO NOTHING`, [channel.tenant_id, channel.business_id, channel.id, conversation.rows[0].id, correlationId, `inbound:${message.messageId}`]);
    return { duplicate: false, messageId: inserted.rows[0].id, conversationId: conversation.rows[0].id, contactId: contact.rows[0].id, displayName: contact.rows[0].display_name, mode: conversation.rows[0].mode, senderType, trainingCaptured, trainingSuppressed };
  });

  if (!created.duplicate && channel.platform === "facebook" && created.contactId && !created.displayName) {
    const jobId = `contact-profile:${created.contactId}`;
    await enqueue(QUEUES.contactProfiles, {
      jobId,
      jobType: "FETCH_FACEBOOK_CONTACT_PROFILE",
      tenantId: channel.tenant_id,
      businessId: channel.business_id,
      channelAccountId: channel.id,
      correlationId,
      idempotencyKey: jobId,
      createdAt: new Date().toISOString(),
      payload: { contactId: created.contactId },
    }, { attempts: 3, removeOnComplete: true, removeOnFail: true });
  }

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

  const trainingActive = await query("SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open' LIMIT 1",[channel.id]);
  if (!created.duplicate && !created.trainingCaptured && !created.trainingSuppressed && !trainingActive.rows[0] && created.mode === "AI") {
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
    await applyProviderDeliveryEvents(request.body,correlationId);
    const normalized = normalizeMetaPayload(request.body);
    const results = [];
    for (const message of normalized) results.push(await ingestOne(message, correlationId));
    reply.code(200).send({ ok: true, received: normalized.length, results });
  });

  app.post("/v1/internal/meta/events", async (request, reply) => {
    const auth = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!safeSecretEqual(auth, env().INTERNAL_SERVICE_AUTH_SECRET)) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Unauthorized.");
    const correlationId = requestId(request);
    const normalized = normalizeMetaPayload(request.body);
    const results = [];
    for (const message of normalized) results.push(await ingestOne(message, correlationId));
    reply.send({ ok: true, received: normalized.length, results });
  });
}
