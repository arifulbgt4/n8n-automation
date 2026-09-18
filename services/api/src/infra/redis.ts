import Redis from "ioredis";
import type { AppConfig } from "@n8nauto/config";
import { redisNamespace } from "@n8nauto/config";

export function createRedis(config: AppConfig) {
  return new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    keyPrefix: `${redisNamespace(config)}:`
  });
}
