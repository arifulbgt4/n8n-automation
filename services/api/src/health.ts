import { sql } from "drizzle-orm";
import type { AppConfig } from "@n8nauto/config";
import type { Database } from "./db/client.js";
import type Redis from "ioredis";
import { checkMediaStorage } from "./infra/media-storage.js";

async function timed(check: () => Promise<void>) {
  const started = performance.now();
  try {
    await check();
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      message: error instanceof Error ? error.message : "Unknown dependency error"
    };
  }
}

export async function readiness(
  config: AppConfig,
  db: Database,
  redis: Redis
) {
  const [postgres, pgvector, redisHealth, mediaStorage] = await Promise.all([
    timed(async () => {
      await db.execute(sql`select 1`);
    }),
    timed(async () => {
      const result = await db.execute(
        sql`select exists(select 1 from pg_extension where extname = 'vector') as installed`
      );
      const row = result.rows[0] as { installed?: boolean } | undefined;
      if (!row?.installed) throw new Error("pgvector extension is not installed.");
    }),
    timed(async () => {
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error("Redis ping failed.");
    }),
    timed(() => checkMediaStorage(config))
  ]);

  const dependencies = {
    postgres,
    pgvector,
    redis: redisHealth,
    mediaStorage
  };

  return {
    ok: Object.values(dependencies).every((dependency) => dependency.ok),
    service: "api",
    version: config.appVersion,
    dependencies
  } as const;
}
