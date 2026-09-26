import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { enqueue, query, QUEUES, verifyPassword } from "@n8n-automation/core";
import { ApiError, audit, requireAuth, requireCsrf, requireTenant } from "../lib.js";

export async function dataManagementRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/data-requests", async (request, reply) => {
    const { tenantId } = z.object({ tenantId:z.string().uuid() }).parse(request.params);
    await requireTenant(request,tenantId,["OWNER"]);
    const result=await query(`
      SELECT r.*,j.status AS job_status,j.progress,j.error_json,m.original_name AS result_filename
      FROM tenant_data_requests r
      LEFT JOIN job_records j ON j.id=r.job_record_id
      LEFT JOIN media_assets m ON m.id=r.result_media_asset_id
      WHERE r.tenant_id=$1 ORDER BY r.requested_at DESC LIMIT 100
    `,[tenantId]);
    reply.send({requests:result.rows});
  });

  app.post("/v1/tenants/:tenantId/export", async (request, reply) => {
    const { tenantId }=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER"]);
    requireCsrf(request);
    const existing=await query("SELECT 1 FROM tenant_data_requests WHERE tenant_id=$1 AND type='export' AND status IN ('queued','processing')",[tenantId]);
    if(existing.rowCount) throw new ApiError(409,"EXPORT_ALREADY_RUNNING","A tenant export is already in progress.");
    const job=await query<any>(`
      INSERT INTO job_records(tenant_id,type,input_json,created_by)
      VALUES ($1,'tenant_export','{}'::jsonb,$2) RETURNING id,status,created_at
    `,[tenantId,principal.userId]);
    const requestRow=await query<any>(`
      INSERT INTO tenant_data_requests(tenant_id,requested_by,type,status,job_record_id)
      VALUES ($1,$2,'export','queued',$3) RETURNING *
    `,[tenantId,principal.userId,job.rows[0].id]);
    const jobId=`bulk:${job.rows[0].id}`;
    await enqueue(QUEUES.bulk,{jobId,jobType:"TENANT_EXPORT",tenantId,correlationId:jobId,idempotencyKey:jobId,createdAt:new Date().toISOString(),payload:{jobRecordId:job.rows[0].id}});
    await audit({actorUserId:principal.userId,tenantId,action:"TENANT_EXPORT_REQUESTED",resourceType:"tenant_data_request",resourceId:requestRow.rows[0].id,request});
    reply.code(202).send({request:requestRow.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/delete-request", async (request, reply) => {
    const { tenantId }=z.object({tenantId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,tenantId,["OWNER"]);
    requireCsrf(request);
    const input=z.object({confirmation:z.string().min(1),password:z.string().min(1).max(200)}).parse(request.body);
    const [tenant,user]=await Promise.all([
      query<{slug:string;name:string}>("SELECT slug,name FROM tenants WHERE id=$1 AND status<>'deleted'",[tenantId]),
      query<{password_hash:string}>("SELECT password_hash FROM users WHERE id=$1",[principal.userId])
    ]);
    if(!tenant.rows[0]||!user.rows[0]) throw new ApiError(404,"TENANT_NOT_FOUND","Tenant not found.");
    if(input.confirmation !== tenant.rows[0].slug) throw new ApiError(400,"CONFIRMATION_MISMATCH","Type the workspace slug exactly to confirm deletion.");
    if(!(await verifyPassword(input.password,user.rows[0].password_hash))) throw new ApiError(403,"REAUTH_FAILED","Password verification failed.");
    const existing=await query("SELECT 1 FROM tenant_data_requests WHERE tenant_id=$1 AND type='delete' AND status IN ('queued','processing')",[tenantId]);
    if(existing.rowCount) throw new ApiError(409,"DELETE_ALREADY_RUNNING","A deletion request is already in progress.");
    const job=await query<any>(`
      INSERT INTO job_records(tenant_id,type,input_json,created_by)
      VALUES ($1,'tenant_delete','{}'::jsonb,$2) RETURNING id,status,created_at
    `,[tenantId,principal.userId]);
    const requestRow=await query<any>(`
      INSERT INTO tenant_data_requests(tenant_id,requested_by,type,status,job_record_id,metadata)
      VALUES ($1,$2,'delete','queued',$3,$4::jsonb) RETURNING *
    `,[tenantId,principal.userId,job.rows[0].id,JSON.stringify({tenantName:tenant.rows[0].name})]);
    await query("UPDATE tenants SET status='suspended',settings_json=settings_json||'{\"deletion_pending\":true}'::jsonb,updated_at=now() WHERE id=$1",[tenantId]);
    const jobId=`bulk:${job.rows[0].id}`;
    await enqueue(QUEUES.bulk,{jobId,jobType:"TENANT_DELETE",tenantId,correlationId:jobId,idempotencyKey:jobId,createdAt:new Date().toISOString(),payload:{jobRecordId:job.rows[0].id}});
    await audit({actorUserId:principal.userId,tenantId,action:"TENANT_DELETE_REQUESTED",resourceType:"tenant_data_request",resourceId:requestRow.rows[0].id,request});
    reply.code(202).send({request:requestRow.rows[0]});
  });

  app.post("/v1/tenants/:tenantId/data-requests/:requestId/cancel", async (request, reply) => {
    const params=z.object({tenantId:z.string().uuid(),requestId:z.string().uuid()}).parse(request.params);
    const principal=await requireAuth(request);
    await requireTenant(request,params.tenantId,["OWNER"]);
    requireCsrf(request);
    const row=await query<any>(`
      UPDATE tenant_data_requests SET status='cancelled'
      WHERE id=$1 AND tenant_id=$2 AND status='queued'
      RETURNING job_record_id,type
    `,[params.requestId,params.tenantId]);
    if(!row.rows[0]) throw new ApiError(409,"REQUEST_NOT_CANCELLABLE","The request is no longer cancellable.");
    await query("UPDATE job_records SET status='cancelled',updated_at=now() WHERE id=$1 AND status='queued'",[row.rows[0].job_record_id]);
    if(row.rows[0].type==="delete") await query("UPDATE tenants SET status='active',settings_json=settings_json-'deletion_pending',updated_at=now() WHERE id=$1",[params.tenantId]);
    await audit({actorUserId:principal.userId,tenantId:params.tenantId,action:"TENANT_DATA_REQUEST_CANCELLED",resourceType:"tenant_data_request",resourceId:params.requestId,request});
    reply.send({ok:true});
  });
}
