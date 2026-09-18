import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export type OAuthStatePayload = Readonly<{
  userId: string;
  tenantId: string;
  businessId: string;
  platform: "FACEBOOK" | "INSTAGRAM" | "WHATSAPP";
  nonce: string;
  createdAt: string;
}>;

export async function createOAuthState(
  redis: Redis,
  input: Omit<OAuthStatePayload, "nonce" | "createdAt">
) {
  const state = randomBytes(32).toString("base64url");
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(24).toString("base64url"),
    createdAt: new Date().toISOString()
  };

  await redis.set(
    `oauth:state:${state}`,
    JSON.stringify(payload),
    "EX",
    600,
    "NX"
  );

  return { state, nonce: payload.nonce, expiresInSeconds: 600 };
}

export async function consumeOAuthState(
  redis: Redis,
  state: string
): Promise<OAuthStatePayload | null> {
  const key = `oauth:state:${state}`;
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  return JSON.parse(raw) as OAuthStatePayload;
}
