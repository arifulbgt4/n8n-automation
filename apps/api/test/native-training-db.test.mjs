import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, db } from "@n8n-automation/core";
import { captureTrainingMessage, trainingDatasetState } from "../src/training-session.ts";

test("native training keeps strict session windows, deduplicates events, and reuses earlier examples", {skip:!process.env.DATABASE_URL}, async () => {
  const client=await db().connect();
  await client.query("BEGIN");
  try {
    const slug=`native-training-${randomUUID()}`;
    const tenant=(await client.query("INSERT INTO tenants(name,slug) VALUES('Training test',$1) RETURNING id",[slug])).rows[0].id;
    const business=(await client.query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Training test','business') RETURNING id",[tenant])).rows[0].id;
    const agent=(await client.query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Agent') RETURNING id",[tenant,business])).rows[0].id;
    const channel=(await client.query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id) VALUES($1,$2,'facebook','Page',$3,$4) RETURNING id",[tenant,business,slug,agent])).rows[0].id;
    const contact=(await client.query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'customer') RETURNING id",[tenant,business,channel])).rows[0].id;
    const conversation=(await client.query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode) VALUES($1,$2,$3,$4,'AI') RETURNING id",[tenant,business,channel,contact])).rows[0].id;
    const first=(await client.query(`INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status,created_at,stopped_at)
      VALUES($1,$2,$3,$4,'closed','2026-09-28T10:00:00Z','2026-09-28T10:05:00Z') RETURNING id`,[tenant,business,agent,channel])).rows[0].id;
    const second=(await client.query(`INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status,created_at)
      VALUES($1,$2,$3,$4,'open','2026-09-28T11:00:00Z') RETURNING id`,[tenant,business,agent,channel])).rows[0].id;
    const capture=(messageId,direction,text,providerTimestamp)=>captureTrainingMessage(client,{
      tenantId:tenant,businessId:business,channelId:channel,conversationId:conversation,
      sourceMessageId:randomUUID(),platformMessageId:messageId,direction,text,providerTimestamp,
    });

    assert.equal(await capture("before","CONTACT","Old question","2026-09-28T09:59:59Z"),false);
    assert.equal(await capture("q1","CONTACT","First question","2026-09-28T10:00:00Z"),true);
    assert.equal(await capture("a1","HUMAN","First answer","2026-09-28T10:01:00Z"),true);
    assert.equal(await capture("q1","CONTACT","First question","2026-09-28T10:00:00Z"),false);
    assert.equal(await capture("at-stop","CONTACT","Too late","2026-09-28T10:05:00Z"),false);
    assert.equal(await capture("between","CONTACT","No session","2026-09-28T10:30:00Z"),false);
    const initial=await trainingDatasetState(client,tenant,agent);
    assert.equal(initial.exampleIds.length,1);

    assert.equal(await capture("q2","CONTACT","Second question","2026-09-28T11:00:00Z"),true);
    assert.equal(await capture("a2","HUMAN","Second answer","2026-09-28T11:01:00Z"),true);
    const next=await trainingDatasetState(client,tenant,agent);
    assert.equal(next.exampleIds.length,2);
    assert.notEqual(next.datasetDigest,initial.datasetDigest);

    // A delayed webhook in the first, already closed window changes the
    // current dataset. A preexisting candidate must fail the digest check.
    assert.equal(await capture("q1-late","CONTACT","A follow-up","2026-09-28T10:02:00Z"),true);
    assert.equal(await capture("a1-late","HUMAN","Follow-up answer","2026-09-28T10:03:00Z"),true);
    const late=await trainingDatasetState(client,tenant,agent);
    assert.equal(late.exampleIds.length,3);
    assert.notEqual(late.datasetDigest,next.datasetDigest);
    const rows=await client.query("SELECT training_session_id,input_text,ideal_response FROM training_examples WHERE agent_profile_id=$1 ORDER BY created_at,id",[agent]);
    assert.equal(rows.rows.filter(row=>row.training_session_id===first).length,2);
    assert.equal(rows.rows.filter(row=>row.training_session_id===second).length,1);

    await client.query("DELETE FROM training_sessions WHERE id=$1",[first]);
    const retained=await client.query("SELECT count(*)::int AS count FROM training_examples WHERE agent_profile_id=$1 AND training_session_id IS NULL",[agent]);
    assert.equal(retained.rows[0].count,2);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await closeDb();
  }
});
