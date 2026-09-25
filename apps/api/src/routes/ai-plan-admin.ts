import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "@n8n-automation/core";
import { ApiError, audit, requireCsrf, requireRecentPlatformAdmin } from "../lib.js";

export async function aiPlanAdminRoutes(app:FastifyInstance){
  app.patch("/v1/admin/plans/:planId/ai-allowance",async(request,reply)=>{
    const principal=await requireRecentPlatformAdmin(request);requireCsrf(request);
    const {planId}=z.object({planId:z.string().uuid()}).parse(request.params);
    const input=z.object({monthlyAiTokens:z.number().int().nonnegative(),monthlyAiCredits:z.number().nonnegative(),active:z.boolean().optional()}).parse(request.body);
    const result=await query<any>(`
      UPDATE plans SET
        limits=limits||jsonb_build_object('monthlyAiTokens',$2::bigint,'monthlyAiCredits',$3::numeric),
        features=features||'{"platformManagedAi":true}'::jsonb,
        active=COALESCE($4,active),updated_at=now()
      WHERE id=$1 RETURNING *
    `,[planId,input.monthlyAiTokens,input.monthlyAiCredits,input.active??null]);
    if(!result.rows[0]) throw new ApiError(404,"PLAN_NOT_FOUND","Plan not found.");
    await audit({actorUserId:principal.userId,actorType:"platform_admin",action:"PLAN_AI_ALLOWANCE_UPDATED",resourceType:"plan",resourceId:planId,safeDiff:input,request});
    reply.send({plan:result.rows[0]});
  });
}
