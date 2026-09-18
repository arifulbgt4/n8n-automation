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

async function schedulePolicyFollowup(input:{tenantId:string;businessId:string;channelAccountId:string;conversationId:string;agentProfileId?:string|null;turnId:string}) {
  const policy=await query<any>(`
    SELECT * FROM followup_policies
    WHERE tenant_id=$1 AND business_id=$2 AND active=true
      AND (agent_profile_id IS NULL OR agent_profile_id=$3)
      AND (channel_account_id IS NULL OR channel_account_id=$4)
    ORDER BY (channel_account_id IS NOT NULL) DESC,(agent_profile_id IS NOT NULL) DESC,updated_at DESC
    LIMIT 1
  `,[input.tenantId,input.businessId,input.agentProfileId??null,input.channelAccountId]);
  const row=policy.rows[0];
  if(!row?.message_template)return null;
  const key=`policy:${row.id}:turn:${input.turnId}`;
  const created=await query<any>(`
    INSERT INTO followup_jobs(tenant_id,business_id,channel_account_id,conversation_id,agent_profile_id,due_at,policy_snapshot,idempotency_key)
    VALUES ($1,$2,$3,$4,$5,now()+($6 || ' minutes')::interval,$7::jsonb,$8)
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING *
  `,[input.tenantId,input.businessId,input.channelAccountId,input.conversationId,input.agentProfileId??null,String(row.delay_minutes),JSON.stringify({
    policyId:row.id,policyName:row.name,message:row.message_template,maxWindowHours:Number(row.max_window_hours),rules:row.rules_json??{}
  }),key]);
  return created.rows[0]??null;
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
      if (!(ai.actions ?? []).some((action:any)=>action.tool==="schedule_followup")) {
        await schedulePolicyFollowup({
          tenantId:ai.tenantId,businessId:ai.businessId,channelAccountId:ai.channelAccountId,
          conversationId:ai.conversationId,agentProfileId:ai.agentProfileId,turnId
        });
      }
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

  app.post("/v1/internal/orchestration/followups/policy", async (request, reply) => {
    requireInternal(request);
    const input=z.object({
      tenantId:z.string().uuid(),businessId:z.string().uuid(),channelAccountId:z.string().uuid(),
      conversationId:z.string().uuid(),agentProfileId:z.string().uuid().nullable().optional(),turnId:z.string().uuid()
    }).parse(request.body);
    const followup=await schedulePolicyFollowup(input);
    reply.send({ok:true,followup});
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

  app.post("/v1/internal/n8n/deployments", async (request, reply) => {
    requireInternal(request);
    const input=z.object({
      environment:z.string().trim().min(1).max(80),
      bundleVersion:z.string().trim().min(1).max(80),
      apiContractVersion:z.string().trim().min(1).max(40).default("1"),
      workflowKey:z.string().trim().min(1).max(120),
      workflowName:z.string().trim().min(1).max(240),
      n8nWorkflowId:z.string().trim().min(1).max(200),
      logicalVersion:z.string().trim().max(200).nullable().optional(),
      active:z.boolean().default(false),
      deploymentStatus:z.enum(["planned","deployed","active","inactive","failed","rolled_back"]).default("deployed"),
      metadata:z.record(z.string(),z.unknown()).default({}),
    }).parse(request.body);
    const previous=await query<{id:string}>(`
      SELECT id FROM automation_deployments
      WHERE environment=$1 AND workflow_key=$2
      ORDER BY deployed_at DESC LIMIT 1
    `,[input.environment,input.workflowKey]);
    const result=await query<any>(`
      INSERT INTO automation_deployments(
        environment,bundle_version,api_contract_version,workflow_key,workflow_name,n8n_workflow_id,
        logical_version,active,deployment_status,previous_deployment_id,metadata,last_seen_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,now())
      ON CONFLICT(environment,workflow_key,bundle_version) DO UPDATE SET
        api_contract_version=EXCLUDED.api_contract_version,workflow_name=EXCLUDED.workflow_name,
        n8n_workflow_id=EXCLUDED.n8n_workflow_id,logical_version=EXCLUDED.logical_version,
        active=EXCLUDED.active,deployment_status=EXCLUDED.deployment_status,
        metadata=EXCLUDED.metadata,last_seen_at=now()
      RETURNING *
    `,[input.environment,input.bundleVersion,input.apiContractVersion,input.workflowKey,input.workflowName,input.n8nWorkflowId,input.logicalVersion??null,input.active,input.deploymentStatus,previous.rows[0]?.id??null,JSON.stringify(input.metadata)]);
    reply.send({deployment:result.rows[0]});
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
