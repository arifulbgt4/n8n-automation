import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { enqueue, env, query, QUEUES, randomToken, transaction } from "@n8n-automation/core";
import { ApiError, requestId } from "../lib.js";

function requireInternal(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || token !== env().INTERNAL_SERVICE_AUTH_SECRET) {
    throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Internal service authentication is required.");
  }
}

async function internalJson(path: string, body: unknown) {
  const response = await fetch(`${env().API_PUBLIC_ORIGIN.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env().INTERNAL_SERVICE_AUTH_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(response.status, (json as any)?.error?.code ?? "INTERNAL_ORCHESTRATION_FAILED", (json as any)?.error?.message ?? `Internal request failed with ${response.status}`, json);
    throw error;
  }
  return json as any;
}

async function processTurn(turnId: string) {
  try {
    const ai = await internalJson("/v1/internal/ai/respond", { turnId });
    const actionResults: unknown[] = [];
    for (let index = 0; index < (ai.actions ?? []).length; index++) {
      const action = ai.actions[index];
      const result = await internalJson("/v1/internal/actions/execute", {
        tenantId: ai.tenantId,
        businessId: ai.businessId,
        channelAccountId: ai.channelAccountId,
        conversationId: ai.conversationId,
        tool: action.tool,
        arguments: action.arguments ?? {},
        idempotencyKey: `turn:${turnId}:action:${index}:${action.tool}`,
      });
      actionResults.push(result);
    }

    if (ai.handoff) {
      await internalJson("/v1/internal/actions/execute", {
        tenantId: ai.tenantId,
        businessId: ai.businessId,
        channelAccountId: ai.channelAccountId,
        conversationId: ai.conversationId,
        tool: "handoff_conversation",
        arguments: { reason: ai.handoffReason ?? null },
        idempotencyKey: `turn:${turnId}:handoff`,
      });
    } else if (Array.isArray(ai.messages) && ai.messages.length) {
      await internalJson("/v1/internal/outbound/enqueue", {
        tenantId: ai.tenantId,
        businessId: ai.businessId,
        channelAccountId: ai.channelAccountId,
        conversationId: ai.conversationId,
        stateVersion: Number(ai.stateVersion),
        messages: ai.messages,
        senderType: "AI",
        priority: "CUSTOMER_ACTIVE",
        logicalResponseId: `turn-${turnId}`,
      });
    }

    await internalJson(`/v1/internal/turns/${turnId}/complete`, { status: "processed", metadata: { actionCount: actionResults.length } });
    return { ok: true, ai, actionResults };
  } catch (error) {
    await internalJson(`/v1/internal/turns/${turnId}/complete`, {
      status: "failed",
      metadata: { error: error instanceof Error ? error.message : "Turn orchestration failed" },
    }).catch(() => undefined);
    throw error;
  }
}

async function sweepFollowups(limit: number) {
  const due = await transaction(async (client) => {
    const rows = await client.query<any>(`
      SELECT id,tenant_id,business_id,channel_account_id,conversation_id,due_at
      FROM followup_jobs
      WHERE status='scheduled' AND due_at<=now()
      ORDER BY due_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `, [limit]);
    if (!rows.rows.length) return [];
    await client.query("UPDATE followup_jobs SET status='queued',updated_at=now() WHERE id=ANY($1::uuid[])", [rows.rows.map((row) => row.id)]);
    return rows.rows;
  });

  for (const row of due) {
    const jobId = `followup:${row.id}`;
    try {
      await enqueue(QUEUES.followups, {
        jobId,
        jobType: "SEND_FOLLOWUP",
        tenantId: row.tenant_id,
        businessId: row.business_id,
        channelAccountId: row.channel_account_id,
        conversationId: row.conversation_id,
        correlationId: randomToken(16),
        idempotencyKey: jobId,
        createdAt: new Date().toISOString(),
        payload: { followupId: row.id },
      });
    } catch (error) {
      await query("UPDATE followup_jobs SET status='scheduled',updated_at=now() WHERE id=$1 AND status='queued'", [row.id]).catch(() => undefined);
      throw error;
    }
  }
  return due.length;
}

export async function orchestrationRoutes(app: FastifyInstance) {
  app.post("/v1/internal/orchestration/turn", async (request, reply) => {
    requireInternal(request);
    const { turnId } = z.object({ turnId: z.string().uuid() }).parse(request.body);
    const result = await processTurn(turnId);
    reply.send(result);
  });

  app.post("/v1/internal/orchestration/followups/sweep", async (request, reply) => {
    requireInternal(request);
    const { limit } = z.object({ limit: z.number().int().min(1).max(500).default(100) }).parse(request.body ?? {});
    const queued = await sweepFollowups(limit);
    reply.send({ ok: true, queued });
  });

  app.post("/v1/internal/orchestration/maintenance", async (request, reply) => {
    requireInternal(request);
    const correlationId = requestId(request);
    const analyticsId = `analytics:${new Date().toISOString().slice(0, 13)}`;
    const maintenanceId = `maintenance:${Date.now()}`;
    await enqueue(QUEUES.analytics, {
      jobId: analyticsId,
      jobType: "ANALYTICS_ROLLUP",
      tenantId: "00000000-0000-0000-0000-000000000000",
      correlationId,
      idempotencyKey: analyticsId,
      createdAt: new Date().toISOString(),
      payload: {},
    }).catch(() => undefined);
    await enqueue(QUEUES.maintenance, {
      jobId: maintenanceId,
      jobType: "CLEAN_EXPIRED_SESSIONS",
      tenantId: "00000000-0000-0000-0000-000000000000",
      correlationId,
      idempotencyKey: maintenanceId,
      createdAt: new Date().toISOString(),
      payload: {},
    });
    reply.send({ ok: true });
  });

  app.post("/v1/internal/n8n/heartbeat", async (request, reply) => {
    requireInternal(request);
    const input = z.object({
      runtimeKey: z.string().trim().min(1).max(120).default("primary"),
      bundleVersion: z.string().trim().min(1).max(80),
      apiContractVersion: z.string().trim().min(1).max(40).default("1"),
      runtimeVersion: z.string().trim().max(80).nullable().optional(),
      workflowManifest: z.record(z.string(), z.unknown()).default({}),
      metadata: z.record(z.string(), z.unknown()).default({}),
    }).parse(request.body);
    await query(`
      INSERT INTO automation_runtime_heartbeats(runtime_key,bundle_version,api_contract_version,runtime_version,workflow_manifest,metadata,last_seen_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now())
      ON CONFLICT(runtime_key) DO UPDATE SET
        bundle_version=EXCLUDED.bundle_version,
        api_contract_version=EXCLUDED.api_contract_version,
        runtime_version=EXCLUDED.runtime_version,
        workflow_manifest=EXCLUDED.workflow_manifest,
        metadata=EXCLUDED.metadata,
        last_seen_at=now()
    `, [input.runtimeKey,input.bundleVersion,input.apiContractVersion,input.runtimeVersion ?? null,JSON.stringify(input.workflowManifest),JSON.stringify(input.metadata)]);
    reply.send({ ok: true, expectedBundleVersion: env().N8N_WORKFLOW_BUNDLE_VERSION });
  });

  app.get("/v1/internal/n8n/config", async (request, reply) => {
    requireInternal(request);
    reply.send({
      bundleVersion: env().N8N_WORKFLOW_BUNDLE_VERSION,
      apiContractVersion: "1",
      endpoints: {
        turn: "/v1/internal/orchestration/turn",
        followupSweep: "/v1/internal/orchestration/followups/sweep",
        maintenance: "/v1/internal/orchestration/maintenance",
        heartbeat: "/v1/internal/n8n/heartbeat",
      },
    });
  });
}
