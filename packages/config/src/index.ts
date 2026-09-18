import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.string().min(1).default("local"),
  APP_VERSION: z.string().min(1).default("0.1.0"),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().min(1).regex(/^[a-zA-Z0-9:_-]+$/).default("n8nauto"),
  MEDIA_BASE_URL: z.string().url(),
  MEDIA_API_KEY: z.string().min(1),
  INTERNAL_SERVICE_AUTH_SECRET: z.string().min(32),
  N8N_WORKFLOW_BUNDLE_VERSION: z.string().min(1).default("0.1.0"),
  AUTH_BASE_URL: z.string().url(),
  AUTH_SECRET: z.string().min(32),
  CUSTOMER_PANEL_ORIGIN: z.string().url(),
  SUPER_ADMIN_PANEL_ORIGIN: z.string().url()
});

export type AppConfig = Readonly<{
  nodeEnv: z.infer<typeof envSchema>["NODE_ENV"];
  appEnv: string;
  appVersion: string;
  api: Readonly<{ host: string; port: number }>;
  databaseUrl: string;
  redisUrl: string;
  redisKeyPrefix: string;
  media: Readonly<{ baseUrl: string; apiKey: string }>;
  internalServiceAuthSecret: string;
  n8nWorkflowBundleVersion: string;
  auth: Readonly<{
    baseUrl: string;
    secret: string;
    trustedOrigins: readonly string[];
  }>;
}>;

export function loadConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid application environment: ${details}`);
  }

  const env = parsed.data;
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV,
    appVersion: env.APP_VERSION,
    api: Object.freeze({ host: env.API_HOST, port: env.API_PORT }),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    redisKeyPrefix: env.REDIS_KEY_PREFIX,
    media: Object.freeze({
      baseUrl: env.MEDIA_BASE_URL.replace(/\/$/, ""),
      apiKey: env.MEDIA_API_KEY
    }),
    internalServiceAuthSecret: env.INTERNAL_SERVICE_AUTH_SECRET,
    n8nWorkflowBundleVersion: env.N8N_WORKFLOW_BUNDLE_VERSION,
    auth: Object.freeze({
      baseUrl: env.AUTH_BASE_URL.replace(/\/$/, ""),
      secret: env.AUTH_SECRET,
      trustedOrigins: Object.freeze([
        env.CUSTOMER_PANEL_ORIGIN.replace(/\/$/, ""),
        env.SUPER_ADMIN_PANEL_ORIGIN.replace(/\/$/, "")
      ])
    })
  });
}

export function redisNamespace(config: AppConfig, purpose?: string): string {
  const base = `${config.redisKeyPrefix}:${config.appEnv}`;
  return purpose ? `${base}:${purpose}` : base;
}
