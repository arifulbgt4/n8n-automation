import type { AppConfig } from "@n8nauto/config";
import { redisNamespace } from "@n8nauto/config";

export const QUEUE_NAMES = [
  "inbound",
  "outbound",
  "media",
  "training",
  "embedding",
  "followup",
  "analytics",
  "maintenance"
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function queuePrefix(config: AppConfig): string {
  return redisNamespace(config, "queue");
}
