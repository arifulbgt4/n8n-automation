export type Platform = "facebook" | "instagram" | "whatsapp";
export type ConversationMode = "AI" | "HUMAN" | "PAUSED";
export type MembershipRole = "OWNER" | "ADMIN" | "STAFF" | "VIEWER";
export type PlatformAdminRole = "SUPER_ADMIN" | "SUPPORT_ADMIN" | "BILLING_ADMIN" | "OPS_ADMIN" | "READONLY_ADMIN";

export type SessionPrincipal = {
  userId: string;
  email: string;
  name: string | null;
  emailVerifiedAt: string | null;
  sessionId: string;
  csrfToken: string;
  platformAdmin: boolean;
  platformAdminRole: PlatformAdminRole | null;
  platformAdminMfaRequired: boolean;
  platformAdminMfaEnabled: boolean;
  mfaVerifiedAt: string | null;
};

export type ResponsePlanMessage =
  | { type: "text"; text: string }
  | { type: "media"; assetId: string; caption?: string | null };

export type ResponsePlan = {
  conversationId: string;
  logicalResponseId: string;
  messages: ResponsePlanMessage[];
  priority: "HUMAN" | "TRANSACTIONAL" | "CUSTOMER_ACTIVE" | "NORMAL" | "FOLLOWUP";
  idempotencyKey: string;
};

export type NormalizedInboundMessage = {
  platform: Platform;
  channelExternalId: string;
  eventId: string;
  messageId: string;
  senderExternalId: string;
  type: "text" | "image" | "audio" | "video" | "document" | "reaction" | "unknown";
  text?: string | null;
  providerMediaId?: string | null;
  providerMediaUrl?: string | null;
  providerTimestamp?: string | null;
  metadata?: Record<string, unknown>;
};

export type EffectiveLimit = {
  key: string;
  value: number;
  source: "provider" | "platform" | "plan" | "admin" | "business" | "channel" | "contact";
};
