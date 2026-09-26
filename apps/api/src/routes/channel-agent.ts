import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant } from "../lib.js";

export async function channelAgentRoutes(app: FastifyInstance) {
  app.put("/v1/tenants/:tenantId/channels/:channelId/default-agent", async (request, reply) => {
    const params = z.object({
      tenantId: z.string().uuid(),
      channelId: z.string().uuid(),
    }).parse(request.params);
    const principal = await requireAuth(request);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);
    requireCsrf(request);

    const input = z.object({
      agentProfileId: z.string().uuid().nullable(),
      backfillOpenConversations: z.boolean().default(true),
    }).parse(request.body ?? {});

    const channelResult = await query<{ id: string; business_id: string; default_agent_profile_id: string | null }>(
      "SELECT id,business_id,default_agent_profile_id FROM channel_accounts WHERE id=$1 AND tenant_id=$2",
      [params.channelId, params.tenantId],
    );
    const channel = channelResult.rows[0];
    if (!channel) throw new ApiError(404, "CHANNEL_NOT_FOUND", "Channel not found.");
    await requireBusinessAccess(request, params.tenantId, channel.business_id, ["OWNER", "ADMIN"]);

    if (input.agentProfileId) {
      const agentResult = await query<{ id: string; status: string; active_prompt_version_id: string | null }>(
        `SELECT id,status,active_prompt_version_id
         FROM agent_profiles
         WHERE id=$1 AND tenant_id=$2 AND business_id=$3`,
        [input.agentProfileId, params.tenantId, channel.business_id],
      );
      const agent = agentResult.rows[0];
      if (!agent) throw new ApiError(400, "AGENT_SCOPE_INVALID", "Selected AI agent does not belong to this business.");
      if (agent.status !== "active") throw new ApiError(409, "AGENT_NOT_ACTIVE", "Selected AI agent is not active.");
      if (!agent.active_prompt_version_id) throw new ApiError(409, "AGENT_PROMPT_MISSING", "Selected AI agent has no active prompt version.");
    }

    const result = await transaction(async (client) => {
      const updated = await client.query<any>(
        `UPDATE channel_accounts
         SET default_agent_profile_id=$3,updated_at=now()
         WHERE id=$1 AND tenant_id=$2
         RETURNING *`,
        [params.channelId, params.tenantId, input.agentProfileId],
      );

      if (input.agentProfileId) {
        await client.query(
          `INSERT INTO agent_channel_links(agent_profile_id,channel_account_id,tenant_id)
           VALUES ($1,$2,$3)
           ON CONFLICT (agent_profile_id,channel_account_id) DO NOTHING`,
          [input.agentProfileId, params.channelId, params.tenantId],
        );
      }

      let backfilled = 0;
      if (input.agentProfileId && input.backfillOpenConversations) {
        const conversations = await client.query(
          `UPDATE conversations
           SET agent_profile_id=$3,updated_at=now()
           WHERE tenant_id=$1
             AND channel_account_id=$2
             AND business_id=$4
             AND status='open'
             AND mode='AI'
             AND agent_profile_id IS NULL`,
          [params.tenantId, params.channelId, input.agentProfileId, channel.business_id],
        );
        backfilled = conversations.rowCount ?? 0;
      }

      return { channel: updated.rows[0], backfilledOpenConversations: backfilled };
    });

    await audit({
      actorUserId: principal.userId,
      tenantId: params.tenantId,
      businessId: channel.business_id,
      action: "CHANNEL_DEFAULT_AGENT_UPDATED",
      resourceType: "channel_account",
      resourceId: params.channelId,
      safeDiff: {
        previousAgentProfileId: channel.default_agent_profile_id,
        agentProfileId: input.agentProfileId,
        backfilledOpenConversations: result.backfilledOpenConversations,
      },
      request,
    });

    reply.send(result);
  });
}
