import { and, eq } from "drizzle-orm";
import type { AppConfig } from "@n8nauto/config";
import type { Database } from "../db/client.js";
import {
  channelAccounts,
  channelCredentials
} from "../db/schema.js";
import { requireTenantMembership } from "../tenancy/permissions.js";
import { requireBusinessAccess } from "../business/service.js";
import { encryptSecret } from "../security/secret-box.js";
import { writeAuditEvent } from "../db/audit.js";

export const CHANNEL_PLATFORMS = ["FACEBOOK", "INSTAGRAM", "WHATSAPP"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export async function listChannels(
  db: Database,
  userId: string,
  tenantId: string,
  businessId: string
) {
  await requireBusinessAccess(db, userId, tenantId, businessId);
  return db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.businessId, businessId)
      )
    );
}

export async function createChannel(
  db: Database,
  input: {
    tenantId: string;
    businessId: string;
    actorUserId: string;
    platform: ChannelPlatform;
    name: string;
    externalAccountId: string;
    externalPublicId?: string;
    apiVersion?: string;
    settings?: Record<string, unknown>;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");
  await requireBusinessAccess(db, input.actorUserId, input.tenantId, input.businessId);

  const [channel] = await db
    .insert(channelAccounts)
    .values({
      tenantId: input.tenantId,
      businessId: input.businessId,
      platform: input.platform,
      name: input.name.trim(),
      externalAccountId: input.externalAccountId.trim(),
      settings: input.settings ?? {},
      ...(input.externalPublicId ? { externalPublicId: input.externalPublicId } : {}),
      ...(input.apiVersion ? { apiVersion: input.apiVersion } : {})
    })
    .returning();

  if (!channel) throw new Error("Channel account creation failed.");

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "CHANNEL_ACCOUNT_CREATED",
    resourceType: "channel_account",
    resourceId: channel.id,
    correlationId: input.correlationId,
    metadata: { platform: input.platform }
  });

  return channel;
}

export async function requireChannelAccess(
  db: Database,
  userId: string,
  tenantId: string,
  businessId: string,
  channelId: string
) {
  await requireBusinessAccess(db, userId, tenantId, businessId);
  const [channel] = await db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.id, channelId),
        eq(channelAccounts.tenantId, tenantId),
        eq(channelAccounts.businessId, businessId)
      )
    )
    .limit(1);

  if (!channel) {
    const error = new Error("Channel account not found.") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  return channel;
}

export async function storeChannelCredential(
  db: Database,
  config: AppConfig,
  input: {
    tenantId: string;
    businessId: string;
    channelId: string;
    actorUserId: string;
    credentialType: string;
    secret: string;
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");
  await requireChannelAccess(
    db,
    input.actorUserId,
    input.tenantId,
    input.businessId,
    input.channelId
  );

  const encrypted = encryptSecret(input.secret, config.credentialEncryptionKey);

  await db
    .insert(channelCredentials)
    .values({
      tenantId: input.tenantId,
      channelAccountId: input.channelId,
      credentialType: input.credentialType,
      ...encrypted,
      rotatedAt: new Date()
    })
    .onConflictDoUpdate({
      target: [channelCredentials.channelAccountId, channelCredentials.credentialType],
      set: {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        rotatedAt: new Date(),
        revokedAt: null,
        updatedAt: new Date()
      }
    });

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: "CHANNEL_CREDENTIAL_ROTATED",
    resourceType: "channel_account",
    resourceId: input.channelId,
    correlationId: input.correlationId,
    metadata: { credentialType: input.credentialType }
  });

  return { configured: true, credentialType: input.credentialType };
}

export async function setChannelState(
  db: Database,
  input: {
    tenantId: string;
    businessId: string;
    channelId: string;
    actorUserId: string;
    action: "ACTIVATE" | "PAUSE" | "DISCONNECT";
    correlationId: string;
  }
) {
  await requireTenantMembership(db, input.actorUserId, input.tenantId, "ADMIN");
  await requireChannelAccess(
    db,
    input.actorUserId,
    input.tenantId,
    input.businessId,
    input.channelId
  );

  const values =
    input.action === "ACTIVATE"
      ? { active: true, connectionStatus: "ACTIVE", updatedAt: new Date() }
      : input.action === "PAUSE"
        ? { active: false, connectionStatus: "PAUSED", updatedAt: new Date() }
        : { active: false, connectionStatus: "DISCONNECTED", updatedAt: new Date() };

  const [channel] = await db
    .update(channelAccounts)
    .set(values)
    .where(eq(channelAccounts.id, input.channelId))
    .returning();

  if (input.action === "DISCONNECT") {
    await db
      .update(channelCredentials)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(channelCredentials.channelAccountId, input.channelId));
  }

  await writeAuditEvent(db, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    actorType: "USER",
    action: `CHANNEL_${input.action}`,
    resourceType: "channel_account",
    resourceId: input.channelId,
    correlationId: input.correlationId
  });

  return channel;
}
