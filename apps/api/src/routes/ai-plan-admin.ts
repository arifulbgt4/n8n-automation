import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CUSTOMER_MEDIA_STORAGE_BYTES, query } from "@n8n-automation/core";
import { ApiError, audit, requireCsrf, requireRecentPlatformAdmin } from "../lib.js";

export async function aiPlanAdminRoutes(app:FastifyInstance){
  app.patch("/v1/admin/plans/:planId/ai-allowance",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request, { roles: ["SUPER_ADMIN", "BILLING_ADMIN"] });requireCsrf(request);
    const {planId}=z.object({planId:z.string().uuid()}).parse(request.params);
    const input=z.object({dailyAiCredits:z.number().nonnegative().max(1_000_000)}).parse(request.body);
    const result=await query<any>(`
      UPDATE plans SET
        limits=(limits-'monthlyAiTokens'-'monthlyAiCredits')||jsonb_build_object('dailyAiCredits',$2::numeric),
        features=features||'{"platformManagedAi":true}'::jsonb,
        active=true,updated_at=now()
      WHERE id=$1 AND key IN ('free','pro') RETURNING *
    `,[planId,input.dailyAiCredits]);
    if(!result.rows[0]) throw new ApiError(404,"PLAN_NOT_FOUND","Plan not found.");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLAN_AI_ALLOWANCE_UPDATED",resourceType:"plan",resourceId:planId,safeDiff:input,request});
    reply.send({plan:result.rows[0]});
  });

  app.patch("/v1/admin/plans/:planId/media-allowance",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request, { roles: ["SUPER_ADMIN", "BILLING_ADMIN"] });requireCsrf(request);
    const {planId}=z.object({planId:z.string().uuid()}).parse(request.params);
    const input=z.object({
      maxImageMegapixels:z.number().positive().max(100),
      maxImageAssets:z.number().int().nonnegative().max(100000),
      maxImageBytes:z.number().int().positive().max(512*1024*1024),
      mediaStorageBytes:z.number().int().nonnegative().max(CUSTOMER_MEDIA_STORAGE_BYTES),
    }).parse(request.body);
    const result=await query<any>(`
      UPDATE plans SET
        limits=limits||jsonb_build_object(
          'maxImageMegapixels',$2::numeric,
          'maxImageAssets',$3::integer,
          'maxImageBytes',$4::bigint,
          'mediaStorageBytes',$5::bigint
        ),updated_at=now()
      WHERE id=$1 AND key IN ('free','pro') RETURNING *
    `,[planId,input.maxImageMegapixels,input.maxImageAssets,input.maxImageBytes,input.mediaStorageBytes]);
    if(!result.rows[0]) throw new ApiError(404,"PLAN_NOT_FOUND","Plan not found.");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLAN_MEDIA_ALLOWANCE_UPDATED",resourceType:"plan",resourceId:planId,safeDiff:input,request});
    reply.send({plan:result.rows[0]});
  });
}
