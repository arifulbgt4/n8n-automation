import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue, query, QUEUES, transaction } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireBusinessAccess, requireCsrf, requireTenant, requestId } from "../lib.js";
import { inspectNativeTrainingCapability } from "../native-training-capability.js";
import { syncTrainingExamples, trainingDatasetState } from "../training-session.js";

const scopeSchema = z.object({ tenantId: z.string().uuid(), agentId: z.string().uuid() });

async function scopedAgent(request: any, tenantId: string, agentId: string) {
  await requireTenant(request, tenantId, ["OWNER", "ADMIN", "STAFF"]);
  const agent = await query<any>("SELECT * FROM agent_profiles WHERE id=$1 AND tenant_id=$2", [agentId,tenantId]);
  if (!agent.rows[0]) throw new ApiError(404,"AGENT_NOT_FOUND","AI agent not found.");
  await requireBusinessAccess(request,tenantId,agent.rows[0].business_id,["OWNER","ADMIN","STAFF"]);
  return agent.rows[0];
}

async function scopedChannel(tenantId: string, businessId: string, channelId: string) {
  const result = await query<any>("SELECT * FROM channel_accounts WHERE id=$1 AND tenant_id=$2 AND business_id=$3", [channelId,tenantId,businessId]);
  if (!result.rows[0]) throw new ApiError(404,"CHANNEL_NOT_FOUND","Channel not found for this agent's business.");
  return result.rows[0];
}

export async function trainingSessionRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/agents/:agentId/training-sessions", async (request, reply) => {
    const params = scopeSchema.parse(request.params);
    const input = z.object({ channelAccountId: z.string().uuid() }).parse(request.query);
    const agent = await scopedAgent(request,params.tenantId,params.agentId);
    const channel = await scopedChannel(params.tenantId,agent.business_id,input.channelAccountId);
    const capability = await inspectNativeTrainingCapability(channel);
    const sessions = await query<any>(`
      SELECT ts.*,
        (SELECT count(*)::int FROM training_session_messages sm WHERE sm.training_session_id=ts.id) AS captured_count,
        (SELECT count(*)::int FROM training_examples te WHERE te.training_session_id=ts.id) AS example_count,
        tj.status AS job_status,tj.candidate_prompt_version_id
      FROM training_sessions ts LEFT JOIN training_jobs tj ON tj.id=ts.candidate_training_job_id
      WHERE ts.tenant_id=$1 AND ts.agent_profile_id=$2 AND ts.channel_account_id=$3
      ORDER BY ts.created_at DESC LIMIT 50
    `, [params.tenantId,params.agentId,input.channelAccountId]);
    reply.send({ sessions: sessions.rows, capability });
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/training-sessions", async (request, reply) => {
    const params = scopeSchema.parse(request.params);
    const input = z.object({ channelAccountId: z.string().uuid() }).parse(request.body);
    const principal = await requireAuth(request);
    const agent = await scopedAgent(request,params.tenantId,params.agentId);
    requireCsrf(request);
    if (agent.status !== "active" || !agent.active_prompt_version_id) throw new ApiError(409,"AGENT_NOT_READY","Activate and publish the agent before training.");
    const channel = await scopedChannel(params.tenantId,agent.business_id,input.channelAccountId);
    if (channel.default_agent_profile_id !== params.agentId) throw new ApiError(409,"CHANNEL_AGENT_MISMATCH","Assign this agent as the channel's default agent first.");
    const capability = await inspectNativeTrainingCapability(channel,true);
    if (!capability.supported) throw new ApiError(409,"NATIVE_TRAINING_UNAVAILABLE",capability.reason);
    const session = await transaction(async (client) => {
      const lockedChannel = await client.query<{default_agent_profile_id:string|null;active:boolean;connection_status:string}>(
        "SELECT default_agent_profile_id,active,connection_status FROM channel_accounts WHERE id=$1 FOR UPDATE",[channel.id]);
      // Business status changes lock the channel before committing. Read it
      // after that lock so a session cannot start on a newly paused business.
      const scopeStatus = await client.query<{business_status:string;tenant_status:string}>(`
        SELECT b.status AS business_status,t.status AS tenant_status
        FROM businesses b JOIN tenants t ON t.id=b.tenant_id WHERE b.id=$1 AND t.id=$2
      `,[agent.business_id,params.tenantId]);
      const lockedAgent = await client.query<{status:string;active_prompt_version_id:string|null}>(
        "SELECT status,active_prompt_version_id FROM agent_profiles WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[agent.id,params.tenantId]);
      if (lockedChannel.rows[0]?.default_agent_profile_id !== params.agentId ||
          !lockedChannel.rows[0]?.active || lockedChannel.rows[0]?.connection_status !== "connected") {
        throw new ApiError(409,"CHANNEL_AGENT_MISMATCH","The channel or its agent assignment changed. Refresh and try again.");
      }
      if (scopeStatus.rows[0]?.business_status !== "active" || scopeStatus.rows[0]?.tenant_status !== "active") {
        throw new ApiError(409,"BUSINESS_NOT_ACTIVE","Activate the business before training this channel.");
      }
      if (lockedAgent.rows[0]?.status !== "active" || !lockedAgent.rows[0]?.active_prompt_version_id) {
        throw new ApiError(409,"AGENT_NOT_READY","Activate and publish the agent before training.");
      }
      const existing = await client.query("SELECT id FROM training_sessions WHERE channel_account_id=$1 AND status='open'",[channel.id]);
      if (existing.rows[0]) throw new ApiError(409,"TRAINING_ALREADY_ON","This channel already has an active training session.");
      const created = await client.query<any>(`
        INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status,created_by,metadata,created_at,updated_at)
        VALUES($1,$2,$3,$4,'open',$5,$6::jsonb,clock_timestamp(),clock_timestamp()) RETURNING *
      `,[params.tenantId,agent.business_id,agent.id,channel.id,principal.userId,JSON.stringify({nativeSource:capability.source})]);
      await client.query(`UPDATE conversations SET state_version=state_version+1,updated_at=now()
        WHERE tenant_id=$1 AND channel_account_id=$2 AND status='open' AND mode='AI'`,[params.tenantId,channel.id]);
      await client.query(`UPDATE followup_jobs SET status='cancelled',updated_at=now()
        WHERE tenant_id=$1 AND channel_account_id=$2 AND status IN ('scheduled','queued')`,[params.tenantId,channel.id]);
      return created.rows[0];
    });
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,
      action:"CHANNEL_TRAINING_STARTED",resourceType:"training_session",resourceId:session.id,
      safeDiff:{channelAccountId:channel.id,agentProfileId:agent.id},request});
    reply.code(201).send({session});
  });

  app.post("/v1/tenants/:tenantId/agents/:agentId/training-sessions/:sessionId/stop", async (request, reply) => {
    const params = scopeSchema.extend({sessionId:z.string().uuid()}).parse(request.params);
    const principal = await requireAuth(request);
    const agent = await scopedAgent(request,params.tenantId,params.agentId);
    requireCsrf(request);
    const result = await transaction(async (client) => {
      const session = await client.query<any>(`
        SELECT * FROM training_sessions WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3 FOR UPDATE
      `,[params.sessionId,params.tenantId,params.agentId]);
      if (!session.rows[0]?.channel_account_id) throw new ApiError(404,"TRAINING_SESSION_NOT_FOUND","Training session not found.");
      if (session.rows[0].status !== "open") return {session:session.rows[0],jobId:session.rows[0].candidate_training_job_id as string|null,created:false};
      const stopped = await client.query<any>(`
        UPDATE training_sessions SET status='closed',stopped_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *
      `,[params.sessionId]);
      await syncTrainingExamples(client,params.sessionId);
      const sessionExamples = await client.query<{count:number}>(
        "SELECT count(*)::int AS count FROM training_examples WHERE training_session_id=$1 AND approval_status='approved'",[params.sessionId]);
      if (!sessionExamples.rows[0]?.count) return {session:stopped.rows[0],jobId:null,created:true};
      const dataset = await trainingDatasetState(client,params.tenantId,params.agentId);
      if (!dataset.exampleIds.length) return {session:stopped.rows[0],jobId:null,created:true};
      const captured = await client.query<{count:number}>(
        "SELECT count(*)::int AS count FROM training_session_messages WHERE training_session_id=$1",[params.sessionId]);
      const collectionVersions = await client.query<{id:string;schema_version:number;updated_at:Date}>(`
        SELECT c.id,c.schema_version,c.updated_at FROM agent_collection_links acl
        JOIN collections c ON c.id=acl.collection_id
        WHERE acl.tenant_id=$1 AND c.tenant_id=$1 AND c.business_id=$2
          AND acl.agent_profile_id=$3 AND c.status='active' ORDER BY c.id
      `,[params.tenantId,agent.business_id,params.agentId]);
      const snapshot = {exampleIds:dataset.exampleIds,datasetDigest:dataset.datasetDigest,basePromptVersionId:agent.active_prompt_version_id,
        collectionVersions:collectionVersions.rows.map((row)=>({id:row.id,schemaVersion:Number(row.schema_version),updatedAt:row.updated_at})),
        capabilities:agent.capabilities??[],behaviorSettings:agent.behavior_settings??{},
        trainingSessionId:params.sessionId,sessionEventCount:captured.rows[0]?.count??0,
        publishPolicy:"manual",capturedAt:new Date().toISOString()};
      const job = await client.query<{id:string}>(`
        INSERT INTO training_jobs(tenant_id,agent_profile_id,base_prompt_version_id,input_snapshot)
        VALUES($1,$2,$3,$4::jsonb) RETURNING id
      `,[params.tenantId,params.agentId,agent.active_prompt_version_id,JSON.stringify(snapshot)]);
      await client.query("UPDATE training_sessions SET candidate_training_job_id=$2 WHERE id=$1",[params.sessionId,job.rows[0].id]);
      return {session:stopped.rows[0],jobId:job.rows[0].id,created:true};
    });
    const queuedJob = result.jobId
      ? await query<{status:string}>("SELECT status FROM training_jobs WHERE id=$1 AND tenant_id=$2",[result.jobId,params.tenantId])
      : null;
    if (result.jobId && queuedJob?.rows[0]?.status === "queued") {
      await enqueue(QUEUES.training,{jobId:result.jobId,jobType:"PROMPT_SYNTHESIS",tenantId:params.tenantId,
        businessId:agent.business_id,correlationId:requestId(request),idempotencyKey:`training:${result.jobId}`,
        createdAt:new Date().toISOString(),payload:{trainingJobId:result.jobId,agentProfileId:params.agentId}});
    }
    if (result.created) await audit({actorUserId:principal.userId,tenantId:params.tenantId,businessId:agent.business_id,
      action:"CHANNEL_TRAINING_STOPPED",resourceType:"training_session",resourceId:params.sessionId,
      safeDiff:{exampleJobCreated:Boolean(result.jobId)},request});
    reply.send({session:result.session,trainingJobId:result.jobId});
  });
}
