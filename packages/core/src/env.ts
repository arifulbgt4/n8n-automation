import { z } from "zod";

const boolish = z.string().optional().transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  QUEUE_PREFIX: z.string().default("n8nauto:development"),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/, "APP_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters"),
  SESSION_COOKIE_NAME: z.string().default("n8nauto_session"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  CSRF_HEADER_NAME: z.string().default("x-csrf-token"),
  CUSTOMER_APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  ADMIN_APP_ORIGIN: z.string().url().default("http://localhost:3001"),
  API_PUBLIC_ORIGIN: z.string().url().default("http://localhost:4000"),
  INTERNAL_SERVICE_AUTH_SECRET: z.string().min(24),
  EMAIL_DELIVERY_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  EMAIL_FROM: z.string().default("no-reply@example.com"),
  MEDIA_BASE_URL: z.string().url().optional().or(z.literal("")),
  MEDIA_API_KEY: z.string().optional(),
  MEDIA_ADMIN_TOKEN: z.string().optional(),
  N8N_TURN_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_TRAINING_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_HEALTH_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  N8N_WORKFLOW_BUNDLE_VERSION: z.string().default("1.0.0"),
  META_GRAPH_API_VERSION: z.string().default("v23.0"),
  META_APP_ID: z.string().optional(),
  META_OAUTH_REDIRECT_URI: z.string().url().optional().or(z.literal("")),
  META_VERIFY_TOKEN: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  AGGREGATION_WINDOW_MS: z.coerce.number().int().min(500).max(30000).default(4500),
  AGGREGATION_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(20),
  AGGREGATION_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(4 * 1024 * 1024),
  OUTBOUND_DEFAULT_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(30),
  OUTBOUND_DEFAULT_BURST: z.coerce.number().int().min(1).max(1000).default(5),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(10),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().max(8192).default(1536),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: boolish,
});

export type AppEnv = z.infer<typeof schema>;

let cached: AppEnv | undefined;

export function env(): AppEnv {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function resetEnvForTests(): void {
  cached = undefined;
}
