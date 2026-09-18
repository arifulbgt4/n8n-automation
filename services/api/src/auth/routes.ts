import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance } from "fastify";
import type { AppAuth } from "./auth.js";

export async function registerAuthRoutes(app: FastifyInstance, auth: AppAuth) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(request.url, `${request.protocol}://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const init: RequestInit = {
        method: request.method,
        headers
      };
      if (request.method !== "GET" && request.method !== "HEAD" && request.body != null) {
        init.body = JSON.stringify(request.body);
      }

      const response = await auth.handler(new Request(url, init));
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    }
  });
}
