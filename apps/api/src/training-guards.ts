import type pg from "pg";
import { ApiError } from "./lib.js";

export async function requireChannelTrainingOff(client: pg.PoolClient, tenantId: string, channelId: string) {
  const active = await client.query(`SELECT id FROM training_sessions
    WHERE tenant_id=$1 AND channel_account_id=$2 AND status IN ('open','finalizing') LIMIT 1`, [tenantId, channelId]);
  if (active.rows[0]) throw new ApiError(409, "CHANNEL_TRAINING_ON", "Turn off channel training before changing this channel.");
}

export async function requireBusinessTrainingOff(client: pg.PoolClient, tenantId: string, businessId: string) {
  // Training ON locks its channel first. Lock every channel before checking
  // sessions so an archive cannot cross a concurrent session start.
  await client.query(`SELECT id FROM channel_accounts
    WHERE tenant_id=$1 AND business_id=$2 ORDER BY id FOR UPDATE`, [tenantId, businessId]);
  const active = await client.query(`SELECT id FROM training_sessions
    WHERE tenant_id=$1 AND business_id=$2 AND channel_account_id IS NOT NULL AND status IN ('open','finalizing') LIMIT 1`, [tenantId, businessId]);
  if (active.rows[0]) throw new ApiError(409, "CHANNEL_TRAINING_ON", "Turn off channel training before archiving this business.");
}

export async function requireAgentTrainingOff(client: pg.PoolClient, tenantId: string, agentId: string) {
  await client.query(`SELECT id FROM channel_accounts
    WHERE tenant_id=$1 AND default_agent_profile_id=$2 ORDER BY id FOR UPDATE`, [tenantId, agentId]);
  const active = await client.query(`SELECT id FROM training_sessions
    WHERE tenant_id=$1 AND agent_profile_id=$2 AND channel_account_id IS NOT NULL AND status IN ('open','finalizing') LIMIT 1`, [tenantId, agentId]);
  if (active.rows[0]) throw new ApiError(409, "CHANNEL_TRAINING_ON", "Turn off channel training before changing this agent.");
}
