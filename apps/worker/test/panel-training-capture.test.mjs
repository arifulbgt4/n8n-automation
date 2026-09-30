import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, db } from "@n8n-automation/core";
import { capturePanelTrainingReply, humanReplyOutcomeUnknown, ProviderOutcomeUnknownError } from "../src/panel-training-capture.ts";

test("ambiguous human send outcomes stop automatic retry, explicit provider rejection does not", () => {
  assert.equal(humanReplyOutcomeUnknown(new ProviderOutcomeUnknownError("timeout"),null),true);
  assert.equal(humanReplyOutcomeUnknown(new Error("database commit failed"),"provider-accepted-id"),true);
  assert.equal(humanReplyOutcomeUnknown(Object.assign(new Error("rate limited"),{status:429}),null),false);
});

test("panel capture requires the queued open session and a live, accepted human message", { skip: !process.env.DATABASE_URL }, async () => {
  const client = await db().connect();
  await client.query("BEGIN");
  try {
    const slug = `panel-training-${randomUUID()}`;
    const tenantId = (await client.query("INSERT INTO tenants(name,slug) VALUES('Panel training',$1) RETURNING id", [slug])).rows[0].id;
    const businessId = (await client.query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Panel training','business') RETURNING id", [tenantId])).rows[0].id;
    const agentId = (await client.query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Agent') RETURNING id", [tenantId,businessId])).rows[0].id;

    for (const platform of ["facebook", "instagram", "whatsapp"]) {
      const channelId = (await client.query(`INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id)
        VALUES($1,$2,$3,'Training channel',$4,$5) RETURNING id`, [tenantId,businessId,platform,`${slug}-${platform}`,agentId])).rows[0].id;
      const contactId = (await client.query(`INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id)
        VALUES($1,$2,$3,'customer') RETURNING id`, [tenantId,businessId,channelId])).rows[0].id;
      const conversationId = (await client.query(`INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode)
        VALUES($1,$2,$3,$4,'AI') RETURNING id`, [tenantId,businessId,channelId,contactId])).rows[0].id;
      const sessionId = (await client.query(`INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status,created_at)
        VALUES($1,$2,$3,$4,'open',clock_timestamp()) RETURNING id`, [tenantId,businessId,agentId,channelId])).rows[0].id;
      const addMessage = async ({ text = "A live human answer", sender = "HUMAN", status = "sent", timestamp = null, providerId = `provider-${randomUUID()}` } = {}) => {
        const row = await client.query(`INSERT INTO messages(tenant_id,business_id,channel_account_id,conversation_id,
          platform_message_id,direction,sender_type,message_type,text_content,delivery_status,provider_timestamp)
          VALUES($1,$2,$3,$4,$5,'OUTBOUND',$6,'text',$7,$8,COALESCE($9::timestamptz,clock_timestamp())) RETURNING id`,
          [tenantId,businessId,channelId,conversationId,providerId,sender,text,status,timestamp]);
        return row.rows[0].id;
      };
      const capture = (sourceMessageId, queuedSessionId = sessionId) => capturePanelTrainingReply(client, {
        tenantId,businessId,channelId,conversationId,sessionId:queuedSessionId,sourceMessageId,
      });

      const beforeOn = await addMessage({ timestamp: "2000-01-01T00:00:00Z" });
      assert.equal(await capture(beforeOn), false, `${platform}: before ON`);
      assert.equal(await capture(await addMessage({ sender: "AI" })), false, `${platform}: automated reply`);
      assert.equal(await capture(await addMessage({ status: "failed" })), false, `${platform}: failed send`);
      assert.equal(await capture(await addMessage({ providerId: null })), false, `${platform}: no provider message ID`);
      assert.equal(await capture(await addMessage({ text: "  " })), false, `${platform}: blank reply`);
      assert.equal(await capture(await addMessage({ timestamp: "2099-01-01T00:00:00Z" })), false, `${platform}: future timestamp`);

      const liveMessageId = await addMessage();
      assert.equal(await capture(liveMessageId, null), false, `${platform}: queued before ON`);
      assert.equal(await capture(liveMessageId), true, `${platform}: live accepted reply`);
      assert.equal(await capture(liveMessageId), false, `${platform}: duplicate retry`);
      const captured = await client.query(`SELECT source_message_id,direction,text_content FROM training_session_messages
        WHERE training_session_id=$1`, [sessionId]);
      assert.deepEqual(captured.rows.map(row => [row.source_message_id,row.direction,row.text_content]),
        [[liveMessageId,"HUMAN","A live human answer"]]);

      await client.query("UPDATE training_sessions SET status='closed',stopped_at=clock_timestamp() WHERE id=$1", [sessionId]);
      const afterOff = await addMessage();
      assert.equal(await capture(afterOff), false, `${platform}: sent after OFF`);
      const nextSessionId = (await client.query(`INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status,created_at)
        VALUES($1,$2,$3,$4,'open',clock_timestamp()) RETURNING id`, [tenantId,businessId,agentId,channelId])).rows[0].id;
      const duringNext = await addMessage();
      assert.equal(await capture(duringNext), false, `${platform}: old queued session cannot enter next ON`);
      assert.equal(await capture(duringNext,nextSessionId), true, `${platform}: next ON captures its own reply`);
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await closeDb();
  }
});
