import { decryptSecret, env, query, type NormalizedInboundMessage } from "@n8n-automation/core";
import { inspectMetaPageSubscription } from "./meta-page-subscription.js";

export type NativeTrainingCapability = {
  supported: boolean;
  status: "ready" | "unverified" | "unsupported";
  source: "facebook_page_inbox" | "customer_panel" | null;
  reason: string;
};

const capabilityCache = new Map<string,{value:NativeTrainingCapability;expiresAt:number}>();
// Meta's Page Inbox app ID, as used by the Messenger Handover sample.
const PAGE_INBOX_APP_ID = "263902037430900";

export async function inspectNativeTrainingCapability(channel: any, forceRefresh = false): Promise<NativeTrainingCapability> {
  if (!channel?.active || channel.connection_status !== "connected") {
    return { supported: false, status: "unverified", source: null, reason: "Connect and activate this channel first." };
  }
  if (channel.platform === "instagram") {
    return { supported: true, status: "ready", source: "customer_panel", reason: "Customer Panel replies are captured after provider acceptance. Instagram native-app replies cannot be attributed and are excluded." };
  }
  if (channel.platform === "whatsapp") {
    return { supported: true, status: "ready", source: "customer_panel", reason: "Customer Panel replies are captured after provider acceptance. WhatsApp Business App echoes are not verified and are excluded." };
  }
  if (channel.platform !== "facebook") {
    return { supported: false, status: "unsupported", source: null, reason: "Native reply attribution is unavailable for this channel." };
  }
  const cached=capabilityCache.get(String(channel.id));
  if (!forceRefresh && cached && cached.expiresAt>Date.now()) return cached.value;
  if (!env().META_APP_ID) {
    return { supported: true, status: "ready", source: "customer_panel", reason: "Customer Panel replies are captured after provider acceptance. Page Inbox echoes are not verified." };
  }
  const token = await query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM channel_credentials WHERE tenant_id=$1 AND channel_account_id=$2 AND credential_type='access_token' LIMIT 1",
    [channel.tenant_id, channel.id],
  );
  if (!token.rows[0]) {
    return { supported: true, status: "ready", source: "customer_panel", reason: "Customer Panel replies are captured after provider acceptance. Page Inbox echoes are not verified because the Page token is missing." };
  }
  const inspected = await inspectMetaPageSubscription(channel.external_account_id, decryptSecret(token.rows[0].encrypted_value));
  if (!inspected.ok || !inspected.subscribed || !inspected.subscribedFields?.includes("message_echoes")) {
    return { supported: true, status: "ready", source: "customer_panel", reason: `Customer Panel replies are captured after provider acceptance. Page Inbox echo subscription is unverified: ${inspected.detail}` };
  }
  const value:NativeTrainingCapability={ supported: true, status: "ready", source: "facebook_page_inbox", reason: "Customer Panel replies and subscribed Page Inbox message echoes are captured." };
  capabilityCache.set(String(channel.id),{value,expiresAt:Date.now()+5*60*1000});
  return value;
}

export function isNativeHumanReply(message: NormalizedInboundMessage): boolean {
  const metadata = message.metadata ?? {};
  if (!metadata.isEcho) return false;
  if (message.platform === "facebook") return String(metadata.appId ?? "") === PAGE_INBOX_APP_ID;
  // WhatsApp app echoes are excluded until native-app attribution is verified.
  return false;
}
