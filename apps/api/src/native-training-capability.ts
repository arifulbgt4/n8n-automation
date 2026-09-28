import { decryptSecret, env, query, type NormalizedInboundMessage } from "@n8n-automation/core";
import { inspectMetaPageSubscription } from "./meta-page-subscription.js";

export type NativeTrainingCapability = {
  supported: boolean;
  status: "ready" | "unverified" | "unsupported";
  source: "facebook_page_inbox" | "whatsapp_business_app" | null;
  reason: string;
};

const capabilityCache = new Map<string,{value:NativeTrainingCapability;expiresAt:number}>();

export async function inspectNativeTrainingCapability(channel: any, forceRefresh = false): Promise<NativeTrainingCapability> {
  if (!channel?.active || channel.connection_status !== "connected") {
    return { supported: false, status: "unverified", source: null, reason: "Connect and activate this channel first." };
  }
  if (channel.platform === "instagram") {
    return { supported: false, status: "unsupported", source: null, reason: "Meta's Instagram message echo does not identify whether the reply came from the native app." };
  }
  if (channel.platform === "whatsapp") {
    return { supported: false, status: "unverified", source: null, reason: "WhatsApp Business App Coexistence onboarding and smb_message_echoes subscription must be verified first." };
  }
  if (channel.platform !== "facebook") {
    return { supported: false, status: "unsupported", source: null, reason: "Native reply attribution is unavailable for this channel." };
  }
  const cached=capabilityCache.get(String(channel.id));
  if (!forceRefresh && cached && cached.expiresAt>Date.now()) return cached.value;
  if (!env().META_APP_ID) {
    return { supported: false, status: "unverified", source: null, reason: "The Meta app is not configured." };
  }
  const token = await query<{ encrypted_value: string }>(
    "SELECT encrypted_value FROM channel_credentials WHERE tenant_id=$1 AND channel_account_id=$2 AND credential_type='access_token' LIMIT 1",
    [channel.tenant_id, channel.id],
  );
  if (!token.rows[0]) {
    return { supported: false, status: "unverified", source: null, reason: "The Page access token is missing." };
  }
  const inspected = await inspectMetaPageSubscription(channel.external_account_id, decryptSecret(token.rows[0].encrypted_value));
  if (!inspected.ok || !inspected.subscribed || !inspected.subscribedFields?.includes("message_echoes")) {
    return { supported: false, status: "unverified", source: null, reason: `Page message_echoes subscription could not be verified: ${inspected.detail}` };
  }
  const value:NativeTrainingCapability={ supported: true, status: "ready", source: "facebook_page_inbox", reason: "Page Inbox message echoes are subscribed." };
  capabilityCache.set(String(channel.id),{value,expiresAt:Date.now()+5*60*1000});
  return value;
}

export function isNativeHumanReply(message: NormalizedInboundMessage): boolean {
  const metadata = message.metadata ?? {};
  if (!metadata.isEcho) return false;
  if (message.platform === "facebook") return String(metadata.appId ?? "") === "26390203743090";
  // A future WhatsApp Coexistence onboarding must verify channel eligibility
  // before its native-only smb_message_echoes events can be used for training.
  if (message.platform === "whatsapp") return metadata.echoSource === "smb_message_echoes";
  return false;
}
