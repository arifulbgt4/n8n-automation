import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { AppConfig } from "@n8nauto/config";
import { z } from "zod";
import type { Database } from "../db/client.js";
import type { AppAuth } from "../auth/auth.js";
import { requireSession } from "../auth/auth.js";
import {
  CHANNEL_PLATFORMS,
  createChannel,
  listChannels,
  requireChannelAccess,
  setChannelState,
  storeChannelCredential
} from "./service.js";
import { createOAuthState } from "./oauth-state.js";
import { requireTenantMembership } from "../tenancy/permissions.js";
import { requireBusinessAccess } from "../business/service.js";

const baseParams = z.object({
  tenantId: z.string().uuid(),
  businessId: z.string().uuid()
});
const channelParams = baseParams.extend({ channelId: z.string().uuid() });
const channelInput = z.object({
  platform: z.enum(CHANNEL_PLATFORMS),
  name: z.string().trim().min(1).max(180),
  externalAccountId: z.string().trim().min(1).max(255),
  externalPublicId: z.string().trim().min(1).max(255).optional(),
  apiVersion: z.string().trim().min(1).max(40).optional(),
  settings: z.record(z.string(), z.unknown()).default({})
});
const credentialInput = z.object({
  credentialType: z.string().trim().min(1).max(80),
  secret: z.string().min(1).max(10000)
});
const stateInput = z.object({ platform: z.enum(CHANNEL_PLATFORMS) });
const actionInput = z.object({
  action: z.enum(["ACTIVATE", "PAUSE", "DISCONNECT"])
});

export async function registerChannelRoutes(
  app: FastifyInstance,
  auth: AppAuth,
  db: Database,
  redis: Redis,
  config: AppConfig
) {
  app.get("/v1/tenants/:tenantId/businesses/:businessId/channels", async (request) => {
    const session = await requireSession(auth, request);
    const params = baseParams.parse(request.params);
    return {
      data: await listChannels(
        db,
        session.user.id,
        params.tenantId,
        params.businessId
      )
    };
  });

  app.post("/v1/tenants/:tenantId/businesses/:businessId/channels", async (request, reply) => {
    const session = await requireSession(auth, request);
    const params = baseParams.parse(request.params);
    const body = channelInput.parse(request.body);
    const channel = await createChannel(db, {
      ...params,
      ...body,
      actorUserId: session.user.id,
      correlationId: String(request.id)
    });
    reply.code(201);
    return { data: channel };
  });

  app.get("/v1/tenants/:tenantId/businesses/:businessId/channels/:channelId", async (request) => {
    const session = await requireSession(auth, request);
    const params = channelParams.parse(request.params);
    return {
      data: await requireChannelAccess(
        db,
        session.user.id,
        params.tenantId,
        params.businessId,
        params.channelId
      )
    };
  });

  app.put("/v1/tenants/:tenantId/businesses/:businessId/channels/:channelId/credentials", async (request) => {
    const session = await requireSession(auth, request);
    const params = channelParams.parse(request.params);
    const body = credentialInput.parse(request.body);
    return {
      data: await storeChannelCredential(db, config, {
        ...params,
        ...body,
        actorUserId: session.user.id,
        correlationId: String(request.id)
      })
    };
  });

  app.post("/v1/tenants/:tenantId/businesses/:businessId/channels/:channelId/state", async (request) => {
    const session = await requireSession(auth, request);
    const params = channelParams.parse(request.params);
    const body = actionInput.parse(request.body);
    return {
      data: await setChannelState(db, {
        ...params,
        action: body.action,
        actorUserId: session.user.id,
        correlationId: String(request.id)
      })
    };
  });

  app.post("/v1/tenants/:tenantId/businesses/:businessId/channels/oauth-state", async (request) => {
    const session = await requireSession(auth, request);
    const params = baseParams.parse(request.params);
    const body = stateInput.parse(request.body);
    await requireTenantMembership(db, session.user.id, params.tenantId, "ADMIN");
    await requireBusinessAccess(db, session.user.id, params.tenantId, params.businessId);

    return {
      data: await createOAuthState(redis, {
        userId: session.user.id,
        tenantId: params.tenantId,
        businessId: params.businessId,
        platform: body.platform
      })
    };
  });
}
