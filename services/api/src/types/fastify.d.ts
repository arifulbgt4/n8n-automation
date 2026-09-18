import type { Database } from "../db/client.js";
import type Redis from "ioredis";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
    redis: Redis;
  }
}
