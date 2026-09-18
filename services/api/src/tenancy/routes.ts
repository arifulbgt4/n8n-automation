import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/client.js";
import type { AppAuth } from "../auth/auth.js";
import { requireSession } from "../auth/auth.js";
import {
  acceptTenantInvitation,
  createTenant,
  inviteTenantMember,
  listTenantsForUser
} from "./service.js";
import { TENANT_ROLES } from "./permissions.js";

const tenantCreateSchema = z.object({
  name: z.string().trim().min(2).max(160)
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(TENANT_ROLES).refine((role) => role !== "OWNER", {
    message: "OWNER role cannot be granted through a normal invitation."
  })
});

const acceptSchema = z.object({
  token: z.string().min(20)
});

export async function registerTenantRoutes(
  app: FastifyInstance,
  auth: AppAuth,
  db: Database
) {
  app.get("/v1/tenants", async (request) => {
    const session = await requireSession(auth, request);
    return { data: await listTenantsForUser(db, session.user.id) };
  });

  app.post("/v1/tenants", async (request, reply) => {
    const session = await requireSession(auth, request);
    const body = tenantCreateSchema.parse(request.body);
    const tenant = await createTenant(db, {
      userId: session.user.id,
      name: body.name,
      correlationId: String(request.id)
    });
    reply.code(201);
    return { data: tenant };
  });

  app.post("/v1/tenants/:tenantId/invitations", async (request, reply) => {
    const session = await requireSession(auth, request);
    const params = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const body = inviteSchema.parse(request.body);
    const invitation = await inviteTenantMember(db, {
      tenantId: params.tenantId,
      actorUserId: session.user.id,
      email: body.email,
      role: body.role,
      correlationId: String(request.id)
    });
    reply.code(201);
    return { data: invitation };
  });

  app.post("/v1/tenant-invitations/accept", async (request) => {
    const session = await requireSession(auth, request);
    const body = acceptSchema.parse(request.body);
    const tenantId = await acceptTenantInvitation(db, {
      token: body.token,
      userId: session.user.id,
      userEmail: session.user.email,
      correlationId: String(request.id)
    });
    return { data: { tenantId } };
  });
}
