import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env, query, transaction } from "@n8n-automation/core";
import { chat, embedding } from "../ai-provider.js";
import { ApiError } from "../lib.js";

function requireInternal(request: FastifyRequest) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || token !== env().INTERNAL_SERVICE_AUTH_SECRET) throw new ApiError(401, "INTERNAL_AUTH_REQUIRED", "Internal service authentication is required.");
}

async function resolveTaskModel(tenantId: string, businessId: string, agentId: string | null, taskKey: string, explicitConfigId?: string | null) {
  const result = explicitConfigId
    ? await query<any>(`SELECT m.*,p.provider,p.encrypted_api_key,p.base_url FROM ai_model_configs m JOIN ai_provider_connections p ON p.id=m.provider_connection_id WHERE m.id=$1 AND m.tenant_id=$2 AND m.active=true AND p.status='active'`, [explicitConfigId, tenantId])
    : await query<any>(`
      SELECT m.*,p.provider,p.encrypted_api_key,p.base_url
      FROM ai_model_configs m JOIN ai_provider_connections p ON p.id=m.provider_connection_id
      WHERE m.tenant_id=$1 AND m.active=true AND p.status='active' AND m.task_key=$4
        AND (m.business_id=$2 OR m.business_id IS NULL) AND (m.agent_profile_id=$3 OR m.agent_profile_id IS NULL)
      ORDER BY (m.agent_profile_id IS NOT NULL) DESC,(m.business_id IS NOT NULL) DESC,m.created_at DESC LIMIT 1
    `, [tenantId, businessId, agentId, taskKey]);
  if (!result.rows[0]) throw new ApiError(409, "AI_MODEL_MISSING", `No active ${taskKey} model configuration is available.`);
  return result.rows[0];
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
    const schemas = await query(`
      SELECT c.id,c.name,c.key,c.purpose,
        COALESCE(jsonb_agg(jsonb_build_object('key',f.key,'label',f.label,'type',f.type,'required',f.required,'aiVisible',f.ai_visible) ORDER BY f.display_order) FILTER(WHERE f.id IS NOT NULL),'[]'::jsonb) AS fields
      FROM agent_collection_links acl JOIN collections c ON c.id=acl.collection_id LEFT JOIN collection_fields f ON f.collection_id=c.id
      WHERE acl.agent_profile_id=$1 GROUP BY c.id,c.name,c.key,c.purpose ORDER BY c.name
    `, [row.agent_profile_id]);
    const model = await resolveTaskModel(row.tenant_id, row.business_id, row.agent_profile_id, "PROMPT_SYNTHESIS", row.model_config_id);
    const system = `You are a prompt engineer for a multi-tenant business automation platform. Synthesize a production agent prompt from approved demonstrations. Preserve safety and grounding rules. Do not copy mutable product/service facts into the prompt. Return strict JSON with keys sections (object) and evaluation (object). The sections object should include core_role, tone_language, grounding, capabilities, business_process, human_handoff, restrictions, and custom_instructions.`;
    const result = await chat(model, { model: model.model, parameters: { ...model.parameters, temperature: 0.15 } }, {
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
    let parsed: any;
    try { parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { throw new ApiError(502, "TRAINING_OUTPUT_INVALID", "Prompt synthesis model did not return valid JSON."); }
    if (!parsed.sections || typeof parsed.sections !== "object") throw new ApiError(502, "TRAINING_OUTPUT_INVALID", "Prompt synthesis output is missing sections.");
    const latest = await query<{ version: number }>("SELECT COALESCE(max(version),0)::int AS version FROM prompt_versions WHERE agent_profile_id=$1", [row.agent_profile_id]);
    const version = (latest.rows[0]?.version ?? 0) + 1;
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
      const created = await client.query(`
        INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,source,status,sections_json,assembled_prompt,base_version_id,training_job_id)
        VALUES ($1,$2,$3,'training','candidate',$4::jsonb,$5,$6,$7) RETURNING *
      `, [row.tenant_id,row.agent_profile_id,version,JSON.stringify(parsed.sections),assembled,row.base_prompt_version_id ?? null,trainingJobId]);
      await client.query(`INSERT INTO usage_events(tenant_id,business_id,event_type,quantity,unit,provider,model,task_key,idempotency_key,metadata)
        VALUES ($1,$2,'training_job',1,'job',$3,$4,'PROMPT_SYNTHESIS',$5,$6::jsonb) ON CONFLICT DO NOTHING`, [row.tenant_id,row.business_id,model.provider,model.model,`training:${trainingJobId}`,JSON.stringify(result.usage)]);
      return created.rows[0];
    });
    reply.send({ candidatePromptVersionId: candidate.id, version, sections: parsed.sections, evaluation: { ...(parsed.evaluation ?? {}), validation, passed: validationPassed }, usage: result.usage });
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
      const vectors: Array<{ content: string; vector: number[]; usage: unknown }> = [];
      for (const content of chunks) {
        const embedded = await embedding(model,{model:model.model,parameters:model.parameters ?? {}},content);
        if (embedded.vector.length !== 1536) throw new ApiError(400,"EMBEDDING_DIMENSION_MISMATCH",`Expected 1536 embedding dimensions but provider returned ${embedded.vector.length}.`);
        vectors.push({ content, vector: embedded.vector, usage: embedded.usage });
      }
      await transaction(async (client) => {
        await client.query("UPDATE knowledge_chunks SET active=false WHERE source_id=$1",[input.sourceId]);
        for (let index=0; index<vectors.length; index++) {
          const item=vectors[index];
          await client.query(`INSERT INTO knowledge_chunks(tenant_id,business_id,source_id,source_version,chunk_index,content,embedding,embedding_model,metadata,active)
            VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9::jsonb,true)`,[row.tenant_id,row.business_id,input.sourceId,input.sourceVersion,index,item.content,`[${item.vector.join(",")}]`,model.model,JSON.stringify({sourceTitle:row.title})]);
        }
        await client.query("UPDATE knowledge_sources SET status='ready',updated_at=now() WHERE id=$1 AND source_version=$2",[input.sourceId,input.sourceVersion]);
        await client.query(`INSERT INTO usage_events(tenant_id,business_id,event_type,quantity,unit,provider,model,task_key,idempotency_key,metadata)
          VALUES ($1,$2,'embedding', $3,'chunk',$4,$5,'EMBEDDINGS',$6,$7::jsonb) ON CONFLICT DO NOTHING`,[row.tenant_id,row.business_id,vectors.length,model.provider,model.model,`embedding:${input.sourceId}:${input.sourceVersion}`,JSON.stringify({chunks:vectors.length})]);
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
    const model=await resolveTaskModel(input.tenantId,input.businessId,input.agentProfileId ?? null,"EMBEDDINGS",null);
    const embedded=await embedding(model,{model:model.model,parameters:model.parameters ?? {}},input.query);
    if(embedded.vector.length!==1536) throw new ApiError(400,"EMBEDDING_DIMENSION_MISMATCH","Embedding dimension does not match the configured vector schema.");
    const result=await query(`
      SELECT kc.id,kc.source_id,kc.content,kc.metadata,ks.title,ks.type,1-(kc.embedding <=> $4::vector) AS similarity
      FROM knowledge_chunks kc JOIN knowledge_sources ks ON ks.id=kc.source_id
      WHERE kc.tenant_id=$1 AND kc.business_id=$2 AND kc.active=true AND ks.status='ready'
        AND (ks.agent_profile_id IS NULL OR ks.agent_profile_id=$3)
      ORDER BY kc.embedding <=> $4::vector LIMIT $5
    `,[input.tenantId,input.businessId,input.agentProfileId ?? null,`[${embedded.vector.join(",")}]`,input.limit]);
    reply.send({results:result.rows,usage:embedded.usage});
  });
}
