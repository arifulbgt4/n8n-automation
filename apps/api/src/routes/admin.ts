import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env, query, queue, QUEUES, redis } from "@n8n-automation/core";
import { ApiError, audit, requireCsrf, requirePlatformAdmin } from "../lib.js";

export async function adminRoutes(app: FastifyInstance) {
  app.get("/v1/admin/dashboard", async (request, reply) => {
    const principal = await requirePlatformAdmin(request);
    const [tenants, channels, conversations, usage, outcomes] = await Promise.all([
      query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='active')::int AS active,count(*) FILTER(WHERE status='suspended')::int AS suspended FROM tenants`),
      query(`SELECT platform,count(*)::int AS total,count(*) FILTER(WHERE connection_status='connected' AND active=true)::int AS connected,count(*) FILTER(WHERE connection_status<>'connected' OR active=false)::int AS unhealthy FROM channel_accounts GROUP BY platform ORDER BY platform`),
      query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE status='open')::int AS open,count(*) FILTER(WHERE mode='HUMAN' AND status='open')::int AS human FROM conversations`),
      query(`SELECT event_type,SUM(quantity)::numeric AS quantity,SUM(COALESCE(estimated_cost,0))::numeric AS estimated_cost FROM usage_events WHERE occurred_at>=now()-interval '24 hours' GROUP BY event_type`),
      query(`SELECT (SELECT count(*)::int FROM orders WHERE created_at>=now()-interval '24 hours') AS orders,(SELECT count(*)::int FROM bookings WHERE created_at>=now()-interval '24 hours') AS bookings,(SELECT count(*)::int FROM leads WHERE created_at>=now()-interval '24 hours') AS leads`),
    ]);
    reply.send({ actor: principal.userId, tenants: tenants.rows[0], channels: channels.rows, conversations: conversations.rows[0], usage24h: usage.rows, outcomes24h: outcomes.rows[0] });
  });

  app.get("/v1/admin/tenants", async (request, reply) => {
    await requirePlatformAdmin(request);
    const q = z.object({ q: z.string().max(200).optional(), status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const result = await query(`
      SELECT t.*,p.key AS plan_key,p.name AS plan_name,
        (SELECT count(*)::int FROM tenant_memberships tm WHERE tm.tenant_id=t.id AND tm.status='active') AS member_count,
        (SELECT count(*)::int FROM businesses b WHERE b.tenant_id=t.id AND b.status<>'archived') AS business_count,
        (SELECT count(*)::int FROM channel_accounts c WHERE c.tenant_id=t.id AND c.active=true) AS channel_count
      FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id
      WHERE ($1::text IS NULL OR t.name ILIKE '%'||$1||'%' OR t.slug ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR t.status=$2)
      ORDER BY t.created_at DESC LIMIT $3 OFFSET $4
    `, [q.q ?? null, q.status ?? null, q.limit, q.offset]);
    const count = await query<{ count: string }>("SELECT count(*) FROM tenants WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR slug ILIKE '%'||$1||'%') AND ($2::text IS NULL OR status=$2)", [q.q ?? null, q.status ?? null]);
    reply.send({ tenants: result.rows, total: Number(count.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset });
  });

  app.get("/v1/admin/tenants/:tenantId", async (request, reply) => {
    await requirePlatformAdmin(request);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const tenant = await query(`SELECT t.*,p.key AS plan_key,p.name AS plan_name,p.limits AS plan_limits,p.features AS plan_features FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [tenantId]);
    if (!tenant.rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
    const [members,businesses,channels,usage,media] = await Promise.all([
      query("SELECT tm.*,u.email,u.name,u.last_login_at FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=$1", [tenantId]),
      query("SELECT * FROM businesses WHERE tenant_id=$1 ORDER BY created_at", [tenantId]),
      query("SELECT id,business_id,platform,name,external_account_id,connection_status,active,last_webhook_at,last_delivery_at,created_at FROM channel_accounts WHERE tenant_id=$1 ORDER BY created_at", [tenantId]),
      query("SELECT event_type,SUM(quantity)::numeric AS quantity,SUM(COALESCE(estimated_cost,0))::numeric AS estimated_cost FROM usage_events WHERE tenant_id=$1 AND occurred_at>=now()-interval '30 days' GROUP BY event_type", [tenantId]),
      query("SELECT id,status,quota_bytes,used_bytes,last_health_check_at,key_hint FROM tenant_media_accounts WHERE tenant_id=$1", [tenantId]),
    ]);
    reply.send({ tenant: tenant.rows[0], members: members.rows, businesses: businesses.rows, channels: channels.rows, usage30d: usage.rows, mediaAccount: media.rows[0] ?? null });
  });

  app.patch("/v1/admin/tenants/:tenantId", async (request, reply) => {
    const principal = await requirePlatformAdmin(request);
    requireCsrf(request);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const input = z.object({ status: z.enum(["active", "suspended"]).optional(), planId: z.string().uuid().nullable().optional(), settings: z.record(z.string(), z.unknown()).optional(), reason: z.string().max(1000).optional() }).parse(request.body);
    const result = await query(`UPDATE tenants SET status=COALESCE($2,status),plan_id=CASE WHEN $3::boolean THEN $4::uuid ELSE plan_id END,settings_json=CASE WHEN $5::jsonb IS NULL THEN settings_json ELSE settings_json||$5::jsonb END,updated_at=now() WHERE id=$1 RETURNING *`, [tenantId, input.status ?? null, Object.prototype.hasOwnProperty.call(input,"planId"), input.planId ?? null, input.settings ? JSON.stringify(input.settings) : null]);
    if (!result.rows[0]) throw new ApiError(404, "TENANT_NOT_FOUND", "Tenant not found.");
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", tenantId, action: "ADMIN_TENANT_UPDATED", resourceType: "tenant", resourceId: tenantId, safeDiff: input, request });
    reply.send({ tenant: result.rows[0] });
  });

  app.put("/v1/admin/tenants/:tenantId/limits", async (request, reply) => {
    const principal = await requirePlatformAdmin(request);
    requireCsrf(request);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(request.params);
    const input = z.record(z.string().min(1).max(100), z.number().nonnegative()).parse(request.body);
    for (const [key,value] of Object.entries(input)) {
      await query(`INSERT INTO tenant_limit_overrides(tenant_id,key,value,created_by) VALUES ($1,$2,$3,$4) ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value,reason='admin update',expires_at=NULL,created_by=EXCLUDED.created_by,created_at=now()`, [tenantId,key,value,principal.userId]);
    }
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", tenantId, action: "ADMIN_LIMITS_UPDATED", resourceType: "tenant", resourceId: tenantId, safeDiff: input, request });
    reply.send({ ok: true });
  });

  app.get("/v1/admin/audit", async (request, reply) => {
    await requirePlatformAdmin(request);
    const q = z.object({ tenantId: z.string().uuid().optional(), action: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    const result = await query(`SELECT a.*,u.email AS actor_email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id WHERE ($1::uuid IS NULL OR a.tenant_id=$1) AND ($2::text IS NULL OR a.action=$2) ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`, [q.tenantId ?? null,q.action ?? null,q.limit,q.offset]);
    reply.send({ events: result.rows, limit: q.limit, offset: q.offset });
  });

  app.get("/v1/admin/queues", async (request, reply) => {
    await requirePlatformAdmin(request);
    const stats = [];
    for (const name of Object.values(QUEUES)) {
      const q = queue(name);
      const counts = await q.getJobCounts("waiting","active","delayed","failed","completed","paused");
      const waiting = await q.getWaiting(0,0);
      const isPaused = await q.isPaused();
      stats.push({ name, counts, isPaused, oldestWaitingTimestamp: waiting[0]?.timestamp ?? null });
    }
    reply.send({ queues: stats });
  });

  app.get("/v1/admin/queues/:queueName/jobs", async (request, reply) => {
    await requirePlatformAdmin(request);
    const params=z.object({queueName:z.string().min(1)}).parse(request.params);
    if(!(Object.values(QUEUES) as string[]).includes(params.queueName)) throw new ApiError(404,"QUEUE_NOT_FOUND","Queue not found.");
    const input=z.object({
      state:z.enum(["waiting","active","delayed","failed","completed","paused"]).default("failed"),
      limit:z.coerce.number().int().min(1).max(200).default(50),
    }).parse(request.query);
    const q=queue(params.queueName as (typeof QUEUES)[keyof typeof QUEUES]);
    const jobs=await q.getJobs([input.state],0,input.limit-1,false);
    reply.send({jobs:jobs.map((job)=>({
      id:job.id,name:job.name,data:job.data,attemptsMade:job.attemptsMade,failedReason:job.failedReason,
      timestamp:job.timestamp,processedOn:job.processedOn,finishedOn:job.finishedOn,opts:{attempts:job.opts.attempts,delay:job.opts.delay,priority:job.opts.priority}
    }))});
  });

  app.post("/v1/admin/queues/:queueName/jobs/:jobId/retry", async (request, reply) => {
    const principal=await requirePlatformAdmin(request);
    requireCsrf(request);
    const params=z.object({queueName:z.string().min(1),jobId:z.string().min(1).max(300)}).parse(request.params);
    if(!(Object.values(QUEUES) as string[]).includes(params.queueName)) throw new ApiError(404,"QUEUE_NOT_FOUND","Queue not found.");
    const q=queue(params.queueName as (typeof QUEUES)[keyof typeof QUEUES]);
    const job=await q.getJob(params.jobId);
    if(!job) throw new ApiError(404,"JOB_NOT_FOUND","Queue job not found.");
    const state=await job.getState();
    if(state!=="failed") throw new ApiError(409,"JOB_NOT_RETRYABLE",`Only failed jobs can be retried; current state is ${state}.`);
    await job.retry("failed");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"QUEUE_JOB_RETRIED",resourceType:"queue_job",resourceId:params.jobId,safeDiff:{queue:params.queueName},request});
    reply.send({ok:true});
  });

  app.delete("/v1/admin/queues/:queueName/jobs/:jobId", async (request, reply) => {
    const principal=await requirePlatformAdmin(request);
    requireCsrf(request);
    const params=z.object({queueName:z.string().min(1),jobId:z.string().min(1).max(300)}).parse(request.params);
    if(!(Object.values(QUEUES) as string[]).includes(params.queueName)) throw new ApiError(404,"QUEUE_NOT_FOUND","Queue not found.");
    const q=queue(params.queueName as (typeof QUEUES)[keyof typeof QUEUES]);
    const job=await q.getJob(params.jobId);
    if(!job) throw new ApiError(404,"JOB_NOT_FOUND","Queue job not found.");
    const state=await job.getState();
    if(state==="active") throw new ApiError(409,"ACTIVE_JOB_REMOVE_FORBIDDEN","An active job cannot be removed.");
    await job.remove();
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"QUEUE_JOB_REMOVED",resourceType:"queue_job",resourceId:params.jobId,safeDiff:{queue:params.queueName,state},request});
    reply.send({ok:true});
  });

  app.post("/v1/admin/queues/:queueName/:operation", async (request, reply) => {
    const principal=await requirePlatformAdmin(request);
    requireCsrf(request);
    const params=z.object({queueName:z.string().min(1),operation:z.enum(["pause","resume"])}).parse(request.params);
    if(!(Object.values(QUEUES) as string[]).includes(params.queueName)) throw new ApiError(404,"QUEUE_NOT_FOUND","Queue not found.");
    const q=queue(params.queueName as (typeof QUEUES)[keyof typeof QUEUES]);
    if(params.operation==="pause") await q.pause(); else await q.resume();
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:`QUEUE_${params.operation.toUpperCase()}`,resourceType:"queue",resourceId:params.queueName,request});
    reply.send({ok:true});
  });

  app.get("/v1/admin/health", async (request, reply) => {
    await requirePlatformAdmin(request);
    const health: Record<string, unknown> = {};
    const started = Date.now();
    try { await query("SELECT 1"); health.postgres = { ok: true }; } catch (error) { health.postgres = { ok: false, error: error instanceof Error ? error.message : "error" }; }
    try { const pong = await redis().ping(); health.redis = { ok: pong === "PONG" }; } catch (error) { health.redis = { ok: false, error: error instanceof Error ? error.message : "error" }; }
    const config = env();
    if (config.MEDIA_BASE_URL) {
      const mediaBaseUrl = config.MEDIA_BASE_URL;
      try { const response = await fetch(`${mediaBaseUrl.replace(/\/$/,"")}/healthz`); health.media = { ok: response.ok, status: response.status }; } catch (error) { health.media = { ok: false, error: error instanceof Error ? error.message : "error" }; }
    } else health.media = { ok: false, status: "not_configured" };
    const heartbeat = await query<any>("SELECT * FROM automation_runtime_heartbeats ORDER BY last_seen_at DESC LIMIT 1").catch(() => ({ rows: [] as any[] }));
    const heartbeatRow = heartbeat.rows[0];
    const heartbeatFresh = heartbeatRow ? Date.now() - new Date(heartbeatRow.last_seen_at).getTime() < 180_000 : false;
    if (config.N8N_HEALTH_WEBHOOK_URL) {
      const healthWebhookUrl = config.N8N_HEALTH_WEBHOOK_URL;
      try {
        const response = await fetch(healthWebhookUrl, { headers: { authorization: `Bearer ${config.INTERNAL_SERVICE_AUTH_SECRET}` } });
        health.n8n = {
          ok: response.ok && (!heartbeatRow || heartbeatFresh),
          status: response.status,
          expectedBundleVersion: config.N8N_WORKFLOW_BUNDLE_VERSION,
          reportedBundleVersion: heartbeatRow?.bundle_version ?? null,
          lastHeartbeatAt: heartbeatRow?.last_seen_at ?? null,
        };
      } catch (error) {
        health.n8n = { ok: heartbeatFresh, error: error instanceof Error ? error.message : "error", reportedBundleVersion: heartbeatRow?.bundle_version ?? null, lastHeartbeatAt: heartbeatRow?.last_seen_at ?? null };
      }
    } else {
      health.n8n = {
        ok: heartbeatFresh,
        status: heartbeatRow ? (heartbeatFresh ? "heartbeat_ok" : "heartbeat_stale") : "not_configured",
        expectedBundleVersion: config.N8N_WORKFLOW_BUNDLE_VERSION,
        reportedBundleVersion: heartbeatRow?.bundle_version ?? null,
        lastHeartbeatAt: heartbeatRow?.last_seen_at ?? null,
      };
    }
    reply.send({ health, elapsedMs: Date.now()-started });
  });

  app.get("/v1/admin/automation", async (request, reply) => {
    await requirePlatformAdmin(request);
    const [heartbeats,outbox,followups,deployments,workers] = await Promise.all([
      query("SELECT * FROM automation_runtime_heartbeats ORDER BY last_seen_at DESC"),
      query("SELECT status,count(*)::int AS count,min(created_at) AS oldest FROM outbox_events GROUP BY status ORDER BY status"),
      query("SELECT status,count(*)::int AS count,min(due_at) AS oldest_due FROM followup_jobs GROUP BY status ORDER BY status"),
      query("SELECT * FROM automation_deployments ORDER BY deployed_at DESC LIMIT 200"),
      query("SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC"),
    ]);
    reply.send({
      expectedBundleVersion: env().N8N_WORKFLOW_BUNDLE_VERSION,
      heartbeats: heartbeats.rows,
      deployments: deployments.rows,
      workers: workers.rows,
      outbox: outbox.rows,
      followups: followups.rows,
    });
  });

  app.get("/v1/admin/feature-flags", async (request, reply) => {
    await requirePlatformAdmin(request);
    const result = await query("SELECT * FROM feature_flags ORDER BY key");
    reply.send({ flags: result.rows });
  });

  app.put("/v1/admin/feature-flags/:key", async (request, reply) => {
    const principal = await requirePlatformAdmin(request);
    requireCsrf(request);
    const { key } = z.object({ key: z.string().regex(/^[a-z0-9_.-]+$/).max(120) }).parse(request.params);
    const input = z.object({ enabled: z.boolean(), description: z.string().max(500).nullable().optional(), rules: z.record(z.string(),z.unknown()).default({}) }).parse(request.body);
    const result = await query(`
      INSERT INTO feature_flags(key,description,enabled,rules,updated_by)
      VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT(key) DO UPDATE SET description=COALESCE(EXCLUDED.description,feature_flags.description),enabled=EXCLUDED.enabled,rules=EXCLUDED.rules,updated_by=EXCLUDED.updated_by,updated_at=now()
      RETURNING *
    `, [key,input.description ?? null,input.enabled,JSON.stringify(input.rules),principal.userId]);
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "FEATURE_FLAG_UPDATED", resourceType: "feature_flag", resourceId: key, safeDiff: { enabled: input.enabled, rules: input.rules }, request });
    reply.send({ flag: result.rows[0] });
  });

  app.get("/v1/admin/plans", async (request, reply) => {
    await requirePlatformAdmin(request);
    const result = await query("SELECT * FROM plans ORDER BY created_at");
    reply.send({ plans: result.rows });
  });

  app.post("/v1/admin/plans", async (request, reply) => {
    const principal = await requirePlatformAdmin(request);
    requireCsrf(request);
    const input = z.object({ key: z.string().regex(/^[a-z0-9_-]+$/), name: z.string().min(1).max(120), features: z.record(z.string(),z.unknown()).default({}), limits: z.record(z.string(),z.unknown()).default({}), active: z.boolean().default(true) }).parse(request.body);
    const result = await query(`INSERT INTO plans(key,name,features,limits,active) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING *`, [input.key,input.name,JSON.stringify(input.features),JSON.stringify(input.limits),input.active]);
    await audit({ actorUserId: principal.userId, actorType: "platform_admin", action: "PLAN_CREATED", resourceType: "plan", resourceId: result.rows[0].id, safeDiff: { key: input.key, name: input.name }, request });
    reply.code(201).send({ plan: result.rows[0] });
  });
}
