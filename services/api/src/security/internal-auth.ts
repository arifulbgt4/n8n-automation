import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "@n8nauto/config";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createInternalServiceGuard(config: AppConfig) {
  return async function internalServiceGuard(request: FastifyRequest) {
    const supplied = request.headers["x-internal-service-token"];
    if (typeof supplied !== "string" || !safeEqual(supplied, config.internalServiceAuthSecret)) {
      const error = new Error("Unauthorized internal service request.") as Error & {
        statusCode?: number;
      };
      error.statusCode = 401;
      throw error;
    }
  };
}
