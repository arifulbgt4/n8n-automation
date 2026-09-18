import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import type { AppAuth } from "../auth/auth.js";
import { requireSession } from "../auth/auth.js";
import {
  archiveBusiness,
  createBusiness,
  listBusinesses,
  requireBusinessAccess,
  updateBusiness
} from "./service.js";

const tenantParams = z.object({ tenantId: z.string().uuid() });
const businessParams = z.object({
  tenantId: z.string().uuid(),
  businessId: z.string().uuid()
});
const businessInput = z.object({
  name: z.string().trim().min(2).max(180),
  businessTypeHint: z.string().trim().min(1).max(80).nullable().optional(),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
  currency: z.string().trim().length(3).default("USD"),
  locale: z.string().trim().min(2).max(32).default("en"),
  settings: z.record(z.string(), z.unknown()).default({})
});
const businessPatch = businessInput.partial();

export async function registerBusinessRoutes(
  app: FastifyInstance,
  auth: AppAuth,
  db: Database
) {
  app.get("/v1/tenants/:tenantId/businesses", async (request) => {
    const session = await requireSession(auth, request);
    const { tenantId } = tenantParams.parse(request.params);
    return { data: await listBusinesses(db, session.user.id, tenantId) };
  });

  app.post("/v1/tenants/:tenantId/businesses", async (request, reply) => {
    const session = await requireSession(auth, request);
    const { tenantId } = tenantParams.parse(request.params);
    const body = businessInput.parse(request.body);
    const business = await createBusiness(db, {
      ...body,
      tenantId,
      actorUserId: session.user.id,
      correlationId: String(request.id)
    });
    reply.code(201);
    return { data: business };
  });

  app.get("/v1/tenants/:tenantId/businesses/:businessId", async (request) => {
    const session = await requireSession(auth, request);
    const params = businessParams.parse(request.params);
    return {
      data: await requireBusinessAccess(
        db,
        session.user.id,
        params.tenantId,
        params.businessId
      )
    };
  });

  app.patch("/v1/tenants/:tenantId/businesses/:businessId", async (request) => {
    const session = await requireSession(auth, request);
    const params = businessParams.parse(request.params);
    const body = businessPatch.parse(request.body);
    return {
      data: await updateBusiness(db, {
        ...body,
        ...params,
        actorUserId: session.user.id,
        correlationId: String(request.id)
      })
    };
  });

  app.delete("/v1/tenants/:tenantId/businesses/:businessId", async (request, reply) => {
    const session = await requireSession(auth, request);
    const params = businessParams.parse(request.params);
    await archiveBusiness(db, {
      ...params,
      actorUserId: session.user.id,
      correlationId: String(request.id)
    });
    reply.code(204);
    return reply.send();
  });
}
