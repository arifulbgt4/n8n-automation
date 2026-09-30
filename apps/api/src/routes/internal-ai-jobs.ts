import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, query, transaction } from "@n8n-automation/core";
import { chat, embedding } from "../ai-provider.js";
import { ApiError, requestId, safeSecretEqual } from "../lib.js";
import { assertMonthlyAiAllowance, recordPlatformAiUsage, resolvePlatformModel } from "../platform-ai.js";
import { queueResumedTrainingMessages, releaseFinalizingMessages, restoreTrainingConversations, trainingDatasetState } from "../training-session.js";

function requireInternal(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!safeSecretEqual(token, env().INTERNAL_SERVICE_AUTH_SECRET)) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Internal service authentication is required.");
}

async function resolveTaskModel(tenantId: string, _businessId: string, _agentId: string | null, taskKey: string, _explicitConfigId?: string | null) {
  await assertMonthlyAiAllowance(tenantId);
  const model=await resolvePlatformModel(taskKey);
  if (!model) throw new ApiError(409, "AI_MODEL_MISSING", `No active platform ${taskKey} model is configured.`);
  return model;
}

function chunkText(text: string, maxChars = 3500, overlap = 400): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + maxChars);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf("\n\n", end), normalized.lastIndexOf(". ", end));
      if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary + 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks.filter(Boolean);
}

export function assertTrainingCollectionSnapshot(
  captured: unknown,
  current: Array<{ id: string; schema_version: number }>,
): void {
  // Older jobs did not capture collection versions; retain their existing behavior.
  if (!Array.isArray(captured)) return;
  const capturedIds = captured.map((collection) => collection.id).sort();
  const currentIds = current.map((collection) => collection.id).sort();
  if (JSON.stringify(capturedIds) !== JSON.stringify(currentIds)) {
    throw new ApiError(409, "TRAINING_INPUT_STALE", "The agent's linked collections changed after the training job was created. Start a new training job.");
  }
  for (const collection of captured) {
    const schema = current.find((candidate) => candidate.id === collection.id);
    if (!schema || Number(schema.schema_version) !== Number(collection.schemaVersion)) {
      throw new ApiError(409, "TRAINING_INPUT_STALE", "A linked collection schema changed after the training job was created. Start a new training job.", {
        collectionId: collection.id,
        capturedVersion: collection.schemaVersion,
        currentVersion: schema?.schema_version ?? null,
      });
    }
  }
}

export async function internalAiJobRoutes(app: FastifyInstance) {
  app.post("/v1/internal/training/synthesize", async (request, reply) => {
    requireInternal(request);
    const { trainingJobId } = z.object({ trainingJobId: z.string().uuid() }).parse(request.body);
    const job = await query<any>(`
      SELECT tj.*,a.business_id,a.capabilities,a.behavior_settings,a.name AS agent_name,pv.sections_json AS base_sections,pv.assembled_prompt AS base_prompt
      FROM training_jobs tj JOIN agent_profiles a ON a.id=tj.agent_profile_id
      LEFT JOIN prompt_versions pv ON pv.id=tj.base_prompt_version_id
      WHERE tj.id=$1
    `, [trainingJobId]);
    const row = job.rows[0];
    if (!row) throw new ApiError(404, "TRAINING_JOB_NOT_FOUND", "Training job not found.");
    const exampleIds = Array.isArray(row.input_snapshot?.exampleIds) ? row.input_snapshot.exampleIds : [];
    const examples = await query(`
      SELECT id,input_text,ideal_response,input_json,labels,source
      FROM training_examples WHERE tenant_id=$1 AND agent_profile_id=$2 AND approval_status='approved'
        AND (cardinality($3::uuid[]) = 0 OR id=ANY($3::uuid[]))
      ORDER BY created_at
    `, [row.tenant_id, row.agent_profile_id, exampleIds]);
    if (!examples.rows.length) throw new ApiError(400, "TRAINING_EXAMPLES_REQUIRED", "No approved training examples were found.");
    const schemas = await query<any>(`
      SELECT c.id,c.name,c.key,c.purpose,c.schema_version,c.updated_at,
        COALESCE(jsonb_agg(jsonb_build_object('key',f.key,'label',f.label,'type',f.type,'required',f.required,'aiVisible',f.ai_visible) ORDER BY f.display_order) FILTER(WHERE f.id IS NOT NULL),'[]'::jsonb) AS fields
      FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id LEFT JOIN collection_fields f ON f.collection_id=c.id
      WHERE acl.agent_profile_id=$1 AND acl.tenant_id=$2 AND c.tenant_id=$2 AND c.business_id=$3 AND c.status='active'
      GROUP BY c.id,c.name,c.key,c.purpose,c.schema_version,c.updated_at ORDER BY c.name
    `, [row.agent_profile_id, row.tenant_id, row.business_id]);
    assertTrainingCollectionSnapshot(row.input_snapshot?.collectionVersions, schemas.rows);
    const model = await resolveTaskModel(row.tenant_id, row.business_id, row.agent_profile_id, "PROMPT_SYNTHESIS", row.model_config_id);
    const system = `You are a prompt engineer for a multi-tenant business automation platform. Synthesize a production agent prompt from approved demonstrations. Preserve safety and grounding rules. Do not copy mutable product/service facts into the prompt. Return strict JSON with keys sections (object) and evaluation (object). The sections object should include core_role, tone_language, grounding, capabilities, business_process, human_handoff, restrictions, and custom_instructions.`;
    const result = await chat(model, { model: model.model, parameters: model.parameters ?? {} }, {
      system,
      messages: [{ role: "user", content: JSON.stringify({
        agentName: row.agent_name,
        capabilities: row.capabilities,
        behaviorSettings: row.behavior_settings,
        collectionSchemas: schemas.rows,
        basePromptSections: row.base_sections ?? {},
        examples: examples.rows,
      }) }],
    });
    await recordPlatformAiUsage({tenantId:row.tenant_id,businessId:row.business_id,eventType:"training_job",unit:"job",taskKey:"PROMPT_SYNTHESIS",model,usage:result.usage,idempotencyKey:`training:${trainingJobId}`,correlationId:requestId(request)});
    let parsed: any;
    try { parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new ApiError(502, "TRAINING_OUTPUT_INVALID", "Prompt synthesis model did not return valid JSON."); }
    if (!parsed.sections || typeof parsed.sections !== "object") throw new ApiError(502, "TRAINING_OUTPUT_INVALID", "Prompt synthesis output is missing sections.");
    const assembled = Object.entries(parsed.sections).map(([key,value]) => `## ${key.replace(/_/g," ")}\n${typeof value === "string" ? value : JSON.stringify(value,null,2)}`).join("\n\n");
    const requiredSections=["core_role","tone_language","grounding","capabilities","business_process","human_handoff","restrictions"];
    const validation={
      requiredSectionsPresent:requiredSections.every((key)=>Object.prototype.hasOwnProperty.call(parsed.sections,key)),
      nonEmpty:assembled.trim().length>=100,
      maxLength:assembled.length<=60000,
      noSecretPlaceholders:!/(api[_ -]?key|access[_ -]?token|app[_ -]?secret)\s*[:=]\s*[A-Za-z0-9_-]{12,}/i.test(assembled),
    };
    const validationPassed=Object.values(validation).every(Boolean);
    const candidate = await transaction(async (client) => {
      await client.query("SELECT id FROM agent_profiles WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[row.agent_profile_id,row.tenant_id]);
      const latest = await client.query<{ version: number }>(
        "SELECT COALESCE(max(version),0)::int AS version FROM prompt_versions WHERE agent_profile_id=$1",[row.agent_profile_id]);
      const version = (latest.rows[0]?.version ?? 0) + 1;
      const created = await client.query(`
        INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,source,status,sections_json,assembled_prompt,base_version_id,training_job_id)
        VALUES ($1,$2,$3,'training','candidate',$4::jsonb,$5,$6,$7) RETURNING *
      `, [row.tenant_id,row.agent_profile_id,version,JSON.stringify(parsed.sections),assembled,row.base_prompt_version_id ?? null,trainingJobId]);
      return created.rows[0];
    });
    reply.send({ candidatePromptVersionId: candidate.id, version: candidate.version, sections: parsed.sections, evaluation: { ...(parsed.evaluation ?? {}), validation, passed: validationPassed }, usage: result.usage });
  });

  app.post("/v1/internal/training/finalize", async (request, reply) => {
    requireInternal(request);
    const input = z.object({
      trainingJobId: z.string().uuid(),
      candidatePromptVersionId: z.string().uuid(),
      evaluation: z.record(z.string(), z.unknown()),
      usage: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);
    if (input.evaluation.passed !== true) throw new ApiError(409,"TRAINING_VALIDATION_FAILED","The generated prompt did not pass validation.");
    const scope = await query<{channel_account_id:string}>(`
      SELECT ts.channel_account_id FROM training_sessions ts
      JOIN training_jobs tj ON tj.id=ts.candidate_training_job_id
      WHERE tj.id=$1 AND tj.input_snapshot->>'publishPolicy'='auto_session'
    `,[input.trainingJobId]);
    if (!scope.rows[0]?.channel_account_id) throw new ApiError(404,"TRAINING_SESSION_NOT_FOUND","Automatic training session not found.");
    const outcome = await transaction(async (client) => {
      // Webhook capture, panel sends, Training OFF and final publication share
      // this channel lock. The dataset cannot change while it is checked.
      await client.query("SELECT id FROM channel_accounts WHERE id=$1 FOR UPDATE",[scope.rows[0].channel_account_id]);
      const agent = await client.query<any>(`
        SELECT a.* FROM agent_profiles a JOIN training_sessions ts ON ts.agent_profile_id=a.id
        WHERE ts.candidate_training_job_id=$1 AND a.tenant_id=ts.tenant_id FOR UPDATE OF a
      `,[input.trainingJobId]);
      const session = await client.query<any>(`
        SELECT ts.* FROM training_sessions ts
        WHERE ts.candidate_training_job_id=$1 FOR UPDATE
      `,[input.trainingJobId]);
      if (!session.rows[0]) throw new ApiError(404,"TRAINING_SESSION_NOT_FOUND","Automatic training session not found.");
      const current = session.rows[0];
      const job = await client.query<any>("SELECT * FROM training_jobs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[input.trainingJobId,current.tenant_id]);
      const row = job.rows[0];
      if (!row || row.input_snapshot?.publishPolicy !== "auto_session" || row.agent_profile_id !== current.agent_profile_id) {
        throw new ApiError(409,"TRAINING_JOB_SCOPE_INVALID","Training job does not belong to this session.");
      }
      if (current.status === "closed" && row.status === "completed" && row.candidate_prompt_version_id === input.candidatePromptVersionId) {
        return {alreadyFinalized:true};
      }
      if (current.status !== "finalizing") throw new ApiError(409,"TRAINING_SESSION_NOT_FINALIZING","Training session is not ready to publish.");
      if (!agent.rows[0] || agent.rows[0].status !== "active" || agent.rows[0].active_prompt_version_id !== row.input_snapshot.basePromptVersionId) {
        throw new ApiError(409,"TRAINING_INPUT_STALE","The agent changed while training was running.");
      }
      const prompt = await client.query<any>(`
        SELECT id,status FROM prompt_versions
        WHERE id=$1 AND tenant_id=$2 AND agent_profile_id=$3 AND training_job_id=$4 FOR UPDATE
      `,[input.candidatePromptVersionId,current.tenant_id,current.agent_profile_id,input.trainingJobId]);
      if (!prompt.rows[0] || prompt.rows[0].status !== "candidate") {
        throw new ApiError(409,"TRAINING_CANDIDATE_INVALID","The generated prompt is not a candidate for this job.");
      }
      const snapshot = row.input_snapshot;
      const dataset = await trainingDatasetState(client,current.tenant_id,current.agent_profile_id,true,"native_channel_training");
      if (dataset.datasetDigest !== snapshot.datasetDigest || JSON.stringify(dataset.exampleIds) !== JSON.stringify(snapshot.exampleIds)) {
        throw new ApiError(409,"TRAINING_INPUT_STALE","Training messages changed while the update was running. Retry training.");
      }
      const captured = await client.query<{count:number}>(
        "SELECT count(*)::int AS count FROM training_session_messages WHERE training_session_id=$1",[current.id]);
      if (Number(captured.rows[0]?.count??0) !== Number(snapshot.sessionEventCount??0)) {
        throw new ApiError(409,"TRAINING_INPUT_STALE","New training messages arrived while the update was running. Retry training.");
      }
      const schemas = await client.query<{id:string;schema_version:number}>(`
        SELECT c.id,c.schema_version FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id
        WHERE acl.tenant_id=$1 AND acl.agent_profile_id=$2 AND c.tenant_id=$1
          AND c.business_id=$3 AND c.status='active' ORDER BY c.id
      `,[current.tenant_id,current.agent_profile_id,current.business_id]);
      assertTrainingCollectionSnapshot(snapshot.collectionVersions,schemas.rows);
      await client.query("UPDATE prompt_versions SET status='archived' WHERE agent_profile_id=$1 AND status='active' AND id<>$2",[current.agent_profile_id,input.candidatePromptVersionId]);
      await client.query("UPDATE prompt_versions SET status='active',published_at=now() WHERE id=$1",[input.candidatePromptVersionId]);
      await client.query("UPDATE agent_profiles SET active_prompt_version_id=$2,updated_at=now() WHERE id=$1",[current.agent_profile_id,input.candidatePromptVersionId]);
      await client.query(`UPDATE training_jobs SET status='completed',candidate_prompt_version_id=$2,
        evaluation_json=$3::jsonb,cost_metadata=$4::jsonb,error=NULL,completed_at=now()
        WHERE id=$1`,[input.trainingJobId,input.candidatePromptVersionId,JSON.stringify(input.evaluation),JSON.stringify(input.usage??{})]);
      await client.query("UPDATE training_sessions SET status='closed',updated_at=clock_timestamp() WHERE id=$1",[current.id]);
      await restoreTrainingConversations(client,current.id,current.channel_account_id);
      await releaseFinalizingMessages(client,current.channel_account_id,current.stopped_at);
      await queueResumedTrainingMessages(client,current);
      await client.query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,payload)
        VALUES ($1,'AGENT_PROMPT_PUBLISHED',$2,'agent_profile',$3,$4::jsonb)`,
        [current.tenant_id,current.business_id,current.agent_profile_id,JSON.stringify({promptVersionId:input.candidatePromptVersionId,autoPublished:true,trainingJobId:input.trainingJobId})]);
      return {alreadyFinalized:false};
    });
    reply.send({ok:true,...outcome});
  });

  app.post("/v1/internal/training/fail", async (request, reply) => {
    requireInternal(request);
    const input = z.object({trainingJobId:z.string().uuid(),error:z.string().max(500)}).parse(request.body);
    const scope = await query<{channel_account_id:string}>(`
      SELECT ts.channel_account_id FROM training_sessions ts
      JOIN training_jobs tj ON tj.id=ts.candidate_training_job_id
      WHERE tj.id=$1 AND tj.input_snapshot->>'publishPolicy'='auto_session'
    `,[input.trainingJobId]);
    if (!scope.rows[0]?.channel_account_id) throw new ApiError(404,"TRAINING_SESSION_NOT_FOUND","Automatic training session not found.");
    await transaction(async (client) => {
      await client.query("SELECT id FROM channel_accounts WHERE id=$1 FOR UPDATE",[scope.rows[0].channel_account_id]);
      const session = await client.query<any>("SELECT * FROM training_sessions WHERE candidate_training_job_id=$1 FOR UPDATE",[input.trainingJobId]);
      const current = session.rows[0];
      if (!current || current.status !== "finalizing") return;
      await client.query("UPDATE training_jobs SET status='failed',error=$2,completed_at=now() WHERE id=$1",[input.trainingJobId,input.error]);
      await client.query("UPDATE training_sessions SET status='failed',updated_at=clock_timestamp() WHERE id=$1",[current.id]);
      await restoreTrainingConversations(client,current.id,current.channel_account_id);
      await releaseFinalizingMessages(client,current.channel_account_id,current.stopped_at);
      await queueResumedTrainingMessages(client,current);
    });
    reply.send({ok:true});
  });

  app.post("/v1/internal/knowledge/index", async (request, reply) => {
    requireInternal(request);
    const input = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().positive() }).parse(request.body);
    const source = await query<any>("SELECT * FROM knowledge_sources WHERE id=$1", [input.sourceId]);
    const row = source.rows[0];
    if (!row) throw new ApiError(404, "KNOWLEDGE_NOT_FOUND", "Knowledge source not found.");
    if (Number(row.source_version) !== input.sourceVersion || row.status === "archived") return reply.send({ skipped: true, reason: "stale_version" });
    await query("UPDATE knowledge_sources SET status='indexing',updated_at=now() WHERE id=$1", [input.sourceId]);
    try {
      const model = await resolveTaskModel(row.tenant_id,row.business_id,row.agent_profile_id,"EMBEDDINGS",null);
      const chunks = chunkText(row.content || "");
      if (!chunks.length) throw new ApiError(400,"KNOWLEDGE_EMPTY","Knowledge source has no indexable text.");
      const vectors: Array<{ content: string; vector: number[]; usage: any }> = [];
      for (let index=0;index<chunks.length;index++) {
        if(index>0) await assertMonthlyAiAllowance(row.tenant_id);
        const content=chunks[index];
        const embedded = await embedding(model,{model:model.model,parameters:model.parameters ?? {}},content);
        if (embedded.vector.length !== env().EMBEDDING_DIMENSIONS) throw new ApiError(400,"EMBEDDING_DIMENSION_MISMATCH",`Expected ${env().EMBEDDING_DIMENSIONS} embedding dimensions but provider returned ${embedded.vector.length}.`);
        vectors.push({ content, vector: embedded.vector, usage: embedded.usage });
        await recordPlatformAiUsage({tenantId:row.tenant_id,businessId:row.business_id,eventType:"embedding",unit:"chunk",taskKey:"EMBEDDINGS",model,usage:embedded.usage,idempotencyKey:`embedding:${input.sourceId}:${input.sourceVersion}:${index}`,correlationId:requestId(request),metadata:{sourceId:input.sourceId,sourceVersion:input.sourceVersion,chunkIndex:index}});
      }
      await transaction(async (client) => {
        await client.query("UPDATE knowledge_chunks SET active=false WHERE source_id=$1",[input.sourceId]);
        for (let index=0; index<vectors.length; index++) {
          const item=vectors[index];
          await client.query(`INSERT INTO knowledge_chunks(tenant_id,business_id,source_id,source_version,chunk_index,content,embedding,embedding_model,metadata,active)
            VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9::jsonb,true)`,[row.tenant_id,row.business_id,input.sourceId,input.sourceVersion,index,item.content,`[${item.vector.join(",")}]`,model.model,JSON.stringify({sourceTitle:row.title})]);
        }
        await client.query("UPDATE knowledge_sources SET status='ready',updated_at=now() WHERE id=$1 AND source_version=$2",[input.sourceId,input.sourceVersion]);
      });
      reply.send({ ok:true, chunks:vectors.length, sourceVersion:input.sourceVersion });
    } catch (error) {
      await query("UPDATE knowledge_sources SET status='error',metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1",[input.sourceId,JSON.stringify({indexError:error instanceof Error?error.message:"indexing failed"})]);
      throw error;
    }
  });

  app.post("/v1/internal/knowledge/search", async (request, reply) => {
    requireInternal(request);
    const input=z.object({tenantId:z.string().uuid(),businessId:z.string().uuid(),agentProfileId:z.string().uuid().nullable().optional(),query:z.string().min(1).max(10000),limit:z.number().int().min(1).max(30).default(8)}).parse(request.body);
    const business = await query("SELECT id FROM businesses WHERE id=$1 AND tenant_id=$2 AND status<>'archived'", [input.businessId, input.tenantId]);
    if (!business.rows[0]) throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
    if (input.agentProfileId) {
      const agent = await query("SELECT id FROM agent_profiles WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND status<>'archived'", [input.agentProfileId, input.tenantId, input.businessId]);
      if (!agent.rows[0]) throw new ApiError(400, "AGENT_SCOPE_INVALID", "Agent does not belong to this business.");
    }
    const model=await resolveTaskModel(input.tenantId,input.businessId,input.agentProfileId ?? null,"EMBEDDINGS",null);
    const embedded=await embedding(model,{model:model.model,parameters:model.parameters ?? {}},input.query);
    await recordPlatformAiUsage({tenantId:input.tenantId,businessId:input.businessId,eventType:"ai_call",unit:"call",taskKey:"EMBEDDINGS",model,usage:embedded.usage,idempotencyKey:`knowledge-search:${requestId(request)}`,correlationId:requestId(request),metadata:{operation:"knowledge_search"}});
    if(embedded.vector.length!==env().EMBEDDING_DIMENSIONS) throw new ApiError(400,"EMBEDDING_DIMENSION_MISMATCH","Embedding dimension does not match the configured vector schema.");
    const result=await query(`
      SELECT kc.id,kc.source_id,kc.content,kc.metadata,ks.title,ks.type,1-(kc.embedding <=> $4::vector) AS similarity
      FROM knowledge_chunks kc JOIN knowledge_sources ks ON ks.id=kc.source_id
      WHERE kc.tenant_id=$1 AND kc.business_id=$2 AND ks.tenant_id=$1 AND ks.business_id=$2
        AND kc.active=true AND ks.status='ready'
        AND (ks.agent_profile_id IS NULL OR ks.agent_profile_id=$3)
      ORDER BY kc.embedding <=> $4::vector LIMIT $5
    `,[input.tenantId,input.businessId,input.agentProfileId ?? null,`[${embedded.vector.join(",")}]`,input.limit]);
    reply.send({results:result.rows,usage:embedded.usage});
  });
}
