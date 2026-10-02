import type pg from "pg";

/** Assign a new channel only when its business has one unambiguous, usable agent. */
export async function assignSoleActiveAgentToChannel(
  client: pg.PoolClient,
  input: { tenantId: string; businessId: string; channelId: string },
): Promise<string | null> {
  const candidates = await client.query<{ id: string }>(`
    SELECT agent.id
    FROM agent_profiles agent
    JOIN prompt_versions prompt
      ON prompt.id=agent.active_prompt_version_id
     AND prompt.agent_profile_id=agent.id
     AND prompt.tenant_id=agent.tenant_id
     AND prompt.status='active'
    WHERE agent.tenant_id=$1
      AND agent.business_id=$2
      AND agent.status='active'
    ORDER BY agent.id
    LIMIT 2
  `, [input.tenantId, input.businessId]);
  if (candidates.rows.length !== 1) return null;

  const agentId = candidates.rows[0].id;
  const channel = await client.query(
    `UPDATE channel_accounts
     SET default_agent_profile_id=$4,updated_at=now()
     WHERE id=$1 AND tenant_id=$2 AND business_id=$3 AND default_agent_profile_id IS NULL
     RETURNING id`,
    [input.channelId, input.tenantId, input.businessId, agentId],
  );
  if (!channel.rows[0]) return null;

  await client.query(
    `INSERT INTO agent_channel_links(agent_profile_id,channel_account_id,tenant_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (agent_profile_id,channel_account_id) DO NOTHING`,
    [agentId, input.channelId, input.tenantId],
  );
  await client.query(
    `UPDATE conversations
     SET agent_profile_id=$4,updated_at=now()
     WHERE tenant_id=$1
       AND business_id=$3
       AND channel_account_id=$2
       AND status='open'
       AND mode='AI'
       AND agent_profile_id IS NULL`,
    [input.tenantId, input.channelId, input.businessId, agentId],
  );
  return agentId;
}
