import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AppConfig } from "@n8nauto/config";
import { createDatabase } from "./db/client.js";
import { readiness } from "./health.js";
import { createRedis } from "./infra/redis.js";
import { createInternalServiceGuard } from "./security/internal-auth.js";
import { createAuth } from "./auth/auth.js";
import { registerAuthRoutes } from "./auth/routes.js";

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: {
      level: config.nodeEnv === "production" ? "info" : "debug",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-internal-service-token",
          "MEDIA_API_KEY",
          "INTERNAL_SERVICE_AUTH_SECRET",
          "AUTH_SECRET"
        ],
        censor: "[REDACTED]"
      }
    },
    requestIdHeader: "x-correlation-id"
  });

  const { db, pool } = createDatabase(config);
  const redis = createRedis(config);
  await redis.connect();

  app.decorate("db", db);
  app.decorate("redis", redis);

  await app.register(cors, {
    origin: [...config.auth.trustedOrigins],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });

  const auth = createAuth(config, db, redis);
  await registerAuthRoutes(app, auth);

  app.get("/health/live", async () => ({
    ok: true,
    service: "api",
    version: config.appVersion
  }));

  app.get("/health/ready", async (_request, reply) => {
    const report = await readiness(config, db, redis);
    if (!report.ok) reply.code(503);
    return report;
  });

  const internalGuard = createInternalServiceGuard(config);
  app.get(
    "/internal/health",
    { preHandler: internalGuard },
    async () => ({
      ok: true,
      environment: config.appEnv,
      workflowBundleVersion: config.n8nWorkflowBundleVersion
    })
  );

  app.addHook("onClose", async () => {
    await Promise.allSettled([redis.quit(), pool.end()]);
  });

  return app;
}
