import test from "node:test";
import assert from "node:assert/strict";
import { bullmqJobId, closeQueues, enqueue, queue, QUEUES, redis, redisKey } from "../dist/index.js";

test("Redis namespace and BullMQ job IDs are tenant-safe and idempotent",async(t)=>{
  const suffix=`core-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const q=queue(QUEUES.analytics);
  const jobId=`test:${suffix}`;
  t.after(async()=>{
    const job=await q.getJob(bullmqJobId(jobId)).catch(()=>null);
    if(job)await job.remove().catch(()=>undefined);
    await redis().del(redisKey("test",suffix)).catch(()=>undefined);
    await closeQueues();
  });

  assert.equal(redisKey("test",suffix),`${process.env.QUEUE_PREFIX || "n8nauto:development"}:test:${suffix}`);
  await redis().set(redisKey("test",suffix),"1","EX",30);
  assert.equal(await redis().get(redisKey("test",suffix)),"1");

  const envelope={
    jobId,
    jobType:"TEST_ANALYTICS",
    tenantId:"00000000-0000-4000-8000-000000000001",
    correlationId:suffix,
    idempotencyKey:jobId,
    createdAt:new Date().toISOString(),
    payload:{value:1},
  };
  await enqueue(QUEUES.analytics,envelope);
  await enqueue(QUEUES.analytics,envelope);
  const stored=await q.getJob(bullmqJobId(jobId));
  assert.ok(stored);
  assert.equal(stored.id,bullmqJobId(jobId));
  assert.equal(stored.data.idempotencyKey,jobId);
  assert.equal(stored.data.payload.value,1);
});
