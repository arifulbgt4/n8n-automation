import Redis from "ioredis";
import { loadConfig, redisNamespace } from "@n8nauto/config";

const config = loadConfig();
const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true
});

const heartbeatKey = `${redisNamespace(config, "worker")}:heartbeat:${process.pid}`;
let stopped = false;

async function heartbeat() {
  await redis.set(
    heartbeatKey,
    JSON.stringify({
      pid: process.pid,
      version: config.appVersion,
      at: new Date().toISOString()
    }),
    "EX",
    45
  );
}

await heartbeat();
const timer = setInterval(() => {
  void heartbeat().catch((error) => {
    console.error("Worker heartbeat failed.", error);
  });
}, 15_000);
timer.unref();

async function shutdown(signal: string) {
  if (stopped) return;
  stopped = true;
  console.info(`Worker shutdown requested: ${signal}`);
  clearInterval(timer);
  await redis.del(heartbeatKey).catch(() => undefined);
  await redis.quit();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

console.info("Worker foundation online; feature handlers are registered by later phases.");
