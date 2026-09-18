import { Redis } from "ioredis";
import { Queue, type JobsOptions } from "bullmq";
import { env } from "./env.js";

export const QUEUES = {
  inbound: "inbound-processing",
  outbound: "outbound-messaging",
  media: "media-processing",
  ai: "ai-jobs",
  training: "training-jobs",
  embeddings: "embedding-jobs",
  followups: "followup-jobs",
  analytics: "analytics-rollup",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

let redisConnection: Redis | undefined;
const queues = new Map<QueueName, Queue>();

export function redis(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
  }
  return redisConnection;
}

export function queue(name: QueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const created = new Queue(name, {
    connection: redis(),
    prefix: env().QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 25_000 },
    },
  });
  queues.set(name, created);
  return created;
}

export type JobEnvelope<T extends Record<string, unknown> = Record<string, unknown>> = {
  jobId: string;
  jobType: string;
  tenantId: string;
  businessId?: string;
  channelAccountId?: string;
  conversationId?: string;
  turnId?: string;
  correlationId: string;
  idempotencyKey: string;
  createdAt: string;
  payload: T;
};

export async function enqueue<T extends Record<string, unknown>>(
  name: QueueName,
  envelope: JobEnvelope<T>,
  options: JobsOptions = {},
): Promise<void> {
  await queue(name).add(envelope.jobType, envelope, {
    jobId: envelope.jobId,
    ...options,
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((item) => item.close()));
  queues.clear();
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = undefined;
  }
}

export function redisKey(...parts: Array<string | number>): string {
  return [env().QUEUE_PREFIX, ...parts].join(":");
}
