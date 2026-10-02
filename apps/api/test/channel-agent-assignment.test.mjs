import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { closeDb, query, transaction } from "@n8n-automation/core";
import { assignSoleActiveAgentToChannel } from "../src/channel-agent-assignment.ts";

test("a new channel links its only active prompted agent and leaves ambiguous assignments alone", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const suffix = randomUUID();
  let tenantId;
  try {
    tenantId = (await query(
      "INSERT INTO tenants(name,slug) VALUES('Channel assignment test',$1) RETURNING id",
      [`channel-agent-${suffix}`],
    )).rows[0].id;
    const businessId = (await query(
      "INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Assignment business',$2) RETURNING id",
      [tenantId, `business-${suffix}`],
    )).rows[0].id;

    const createAgent = async (name, withPrompt = true) => {
      const agentId = (await query(
        "INSERT INTO agent_profiles(tenant_id,business_id,name,status) VALUES($1,$2,$3,'active') RETURNING id",
        [tenantId, businessId, `${name}-${suffix}`],
      )).rows[0].id;
      if (withPrompt) {
        const promptId = (await query(`
          INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,status,assembled_prompt)
          VALUES($1,$2,1,'active','Test prompt') RETURNING id
        `, [tenantId, agentId])).rows[0].id;
        await query("UPDATE agent_profiles SET active_prompt_version_id=$2 WHERE id=$1", [agentId, promptId]);
      }
      return agentId;
    };
    const soleAgentId = await createAgent("Sole agent");
    await createAgent("Agent without prompt", false);

    const channelId = (await query(`
      INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id)
      VALUES($1,$2,'facebook','Sole agent page',$3) RETURNING id
    `, [tenantId, businessId, `sole-${suffix}`])).rows[0].id;
    const contactId = (await query(`
      INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id,display_name)
      VALUES($1,$2,$3,$4,'Test contact') RETURNING id
    `, [tenantId, businessId, channelId, `contact-${suffix}`])).rows[0].id;
    const conversationId = (await query(`
      INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,status)
      VALUES($1,$2,$3,$4,'AI','open') RETURNING id
    `, [tenantId, businessId, channelId, contactId])).rows[0].id;

    const assigned = await transaction((client) => assignSoleActiveAgentToChannel(client, {
      tenantId, businessId, channelId,
    }));
    assert.equal(assigned, soleAgentId);
    const channel = await query("SELECT default_agent_profile_id FROM channel_accounts WHERE id=$1", [channelId]);
    assert.equal(channel.rows[0].default_agent_profile_id, soleAgentId);
    const link = await query("SELECT 1 FROM agent_channel_links WHERE agent_profile_id=$1 AND channel_account_id=$2", [soleAgentId, channelId]);
    assert.equal(link.rowCount, 1);
    const conversation = await query("SELECT agent_profile_id FROM conversations WHERE id=$1", [conversationId]);
    assert.equal(conversation.rows[0].agent_profile_id, soleAgentId);

    await createAgent("Second agent");
    const ambiguousChannelId = (await query(`
      INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id)
      VALUES($1,$2,'facebook','Ambiguous page',$3) RETURNING id
    `, [tenantId, businessId, `ambiguous-${suffix}`])).rows[0].id;
    const ambiguous = await transaction((client) => assignSoleActiveAgentToChannel(client, {
      tenantId, businessId, channelId: ambiguousChannelId,
    }));
    assert.equal(ambiguous, null);
    const unassigned = await query("SELECT default_agent_profile_id FROM channel_accounts WHERE id=$1", [ambiguousChannelId]);
    assert.equal(unassigned.rows[0].default_agent_profile_id, null);
    const noLinks = await query("SELECT count(*)::int AS count FROM agent_channel_links WHERE channel_account_id=$1", [ambiguousChannelId]);
    assert.equal(noLinks.rows[0].count, 0);
  } finally {
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await closeDb();
  }
});
