import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { assertDatabaseReady, env, redis, redisKey } from "@n8n-automation/core";
import { ApiError, jsonError, requestId } from "./lib.js";
import { authRoutes } from "./routes/auth.js";
import { tenantRoutes } from "./routes/tenant.js";
import { invitationRoutes } from "./routes/invitations.js";
import { channelRoutes } from "./routes/channels.js";
import { channelAgentRoutes } from "./routes/channel-agent.js";
import { collectionRoutes } from "./routes/collections.js";
import { mediaRoutes } from "./routes/media.js";
import { aiRoutes } from "./routes/ai.js";
import { conversationRoutes } from "./routes/conversations.js";
import { actionRoutes } from "./routes/actions.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { dataManagementRoutes } from "./routes/data-management.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { internalRoutes } from "./routes/internal.js";
import { orchestrationRoutes } from "./routes/orchestration.js";
import { internalAiJobRoutes } from "./routes/internal-ai-jobs.js";
import { adminRoutes } from "./routes/admin.js";
import { platformConfigRoutes } from "./routes/platform-config.js";

const config = env();
const app = Fastify({
  logger: { level: config.LOG_LEVEL, redact: ["req.headers.authorization", "req.headers.cookie", "body.apiKey", "body.accessToken", "body.appSecret"] },
  trustProxy: config.TRUST_PROXY,
  bodyLimit: 2 * 1024 * 1024,
});

// Capture the exact JSON bytes so Meta webhook HMAC verification can use the original body.
app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body: Buffer, done) => {
  try {
    (request as any).rawBody = body;
    done(null, body.length ? JSON.parse(body.toString("utf8")) : {});
  } catch (error) {
    done(error as Error, undefined);
  }
});

await app.register(cookie);
await app.register(cors, {
  origin(origin, callback) {
    if (!origin || [config.CUSTOMER_APP_ORIGIN, config.ADMIN_APP_ORIGIN].includes(origin)) return callback(null, true);
    callback(new Error("Origin not allowed"), false);
  },
  credentials: true,
  allowedHeaders: ["content-type", "authorization", "idempotency-key", config.CSRF_HEADER_NAME, "x-business-id", "x-admin-tenant-access"],
});
await app.register(multipart, {
  limits: { files: 1, fileSize: 512 * 1024 * 1024, fields: 20 },
});

app.addHook("onRequest", async (request, reply) => {
  (request as any).metricsStartedAt = Date.now();
  reply.header("x-request-id", requestId(request));
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
  reply.header("cross-origin-opener-policy", "same-origin");
  if (config.NODE_ENV === "production") reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
});

app.addHook("onResponse", async (request, reply) => {
  const started=Number((request as any).metricsStartedAt ?? Date.now());
  const latency=Math.max(0,Date.now()-started);
  const minute=new Date().toISOString().slice(0,16);
  const key=redisKey("metrics","api",minute);
  const statusClass=`${Math.floor(reply.statusCode/100)}xx`;
  const route=String(request.routeOptions?.url || request.url.split("?")[0]).replace(/[^a-zA-Z0-9_/:.-]/g,"_").slice(0,180);
  try {
    const pipeline=redis().multi();
    pipeline.hincrby(key,"requests",1);
    pipeline.hincrbyfloat(key,"latency_ms_total",latency);
    pipeline.hincrby(key,`status_${statusClass}`,1);
    pipeline.hincrby(key,`route:${route}`,1);
    pipeline.expire(key,48*60*60);
    await pipeline.exec();
  } catch {
    // Metrics must never break request delivery.
  }
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
  if ((error as any).name === "ZodError") {
    const apiError = new ApiError(400, "VALIDATION_ERROR", "Request validation failed.", (error as any).issues ?? []);
    return reply.code(400).send(jsonError(apiError, request));
  }
  request.log.error({ err: error, requestId: requestId(request) }, "Unhandled API error");
  const apiError = new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred.");
  reply.code(500).send(jsonError(apiError, request));
});

app.get("/healthz", async (_request, reply) => reply.send({ status: "ok", service: "api", version: "1.0.0" }));
app.get("/readyz", async (_request, reply) => {
  await assertDatabaseReady();
  const pong = await redis().ping();
  if (pong !== "PONG") throw new Error("Redis health check failed");
  reply.send({ status: "ready" });
});

await authRoutes(app);
await tenantRoutes(app);
await invitationRoutes(app);
await channelRoutes(app);
await channelAgentRoutes(app);
await collectionRoutes(app);
await mediaRoutes(app);
await aiRoutes(app);
await conversationRoutes(app);
await actionRoutes(app);
await knowledgeRoutes(app);
await analyticsRoutes(app);
await dataManagementRoutes(app);
await webhookRoutes(app);
await internalRoutes(app);
await orchestrationRoutes(app);
await internalAiJobRoutes(app);
await adminRoutes(app);
await platformConfigRoutes(app);

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";
await app.listen({ port, host });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down API");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
