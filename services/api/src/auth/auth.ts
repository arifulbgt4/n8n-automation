import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { AppConfig } from "@n8nauto/config";
import type { Database } from "../db/client.js";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerifications
} from "../db/schema.js";
import { enqueueOutboxEvent } from "../db/outbox.js";
import { writeAuditEvent } from "../db/audit.js";

export function createAuth(config: AppConfig, db: Database, redis: Redis) {
  const auth = betterAuth({
    appName: "n8n Automation",
    baseURL: config.auth.baseUrl,
    secret: config.auth.secret,
    trustedOrigins: [...config.auth.trustedOrigins],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications
      }
    }),
    secondaryStorage: {
      get: async (key) => redis.get(`auth:${key}`),
      getAndDelete: async (key) => {
        const namespaced = `auth:${key}`;
        const value = await redis.get(namespaced);
        if (value !== null) await redis.del(namespaced);
        return value;
      },
      increment: async (key, ttl) => {
        const namespaced = `auth:${key}`;
        const value = await redis.incr(namespaced);
        if (value === 1) await redis.expire(namespaced, ttl);
        return value;
      },
      set: async (key, value, ttl) => {
        const namespaced = `auth:${key}`;
        if (ttl) await redis.set(namespaced, value, "EX", ttl);
        else await redis.set(namespaced, value);
      },
      delete: async (key) => {
        await redis.del(`auth:${key}`);
      }
    },
    session: {
      storeSessionInDatabase: true,
      cookieCache: {
        enabled: true,
        maxAge: 300,
        strategy: "jwt"
      }
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        await enqueueOutboxEvent(db, {
          aggregateType: "user",
          aggregateId: user.id,
          eventType: "AUTH_PASSWORD_RESET_EMAIL_REQUESTED",
          payload: { to: user.email, url }
        });
      }
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => {
        await enqueueOutboxEvent(db, {
          aggregateType: "user",
          aggregateId: user.id,
          eventType: "AUTH_VERIFICATION_EMAIL_REQUESTED",
          payload: { to: user.email, url }
        });
      }
    },
    rateLimit: {
      enabled: true,
      storage: "secondary-storage",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 300, max: 5 },
        "/request-password-reset": { window: 300, max: 5 }
      }
    },
    advanced: {
      database: {
        generateId: "uuid",
        validateSchema: true
      }
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await writeAuditEvent(db, {
              actorType: "USER",
              actorUserId: user.id,
              action: "AUTH_USER_CREATED",
              resourceType: "user",
              resourceId: user.id,
              correlationId: `auth-user:${user.id}`
            });
          }
        }
      },
      session: {
        create: {
          after: async (session) => {
            await writeAuditEvent(db, {
              actorType: "USER",
              actorUserId: session.userId,
              action: "AUTH_SESSION_CREATED",
              resourceType: "session",
              resourceId: session.id,
              correlationId: `auth-session:${session.id}`,
              ...(session.ipAddress ? { ipAddress: session.ipAddress } : {}),
              ...(session.userAgent ? { userAgent: session.userAgent } : {})
            });
          }
        }
      }
    }
  });

  return auth;
}

export type AppAuth = ReturnType<typeof createAuth>;

export async function requireSession(auth: AppAuth, request: FastifyRequest) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(request.headers)
  });
  if (!session) {
    const error = new Error("Authentication required.") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return session;
}
