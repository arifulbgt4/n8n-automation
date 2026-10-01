BEGIN;

DROP INDEX training_sessions_one_open_channel;
CREATE UNIQUE INDEX training_sessions_one_open_channel
  ON training_sessions(channel_account_id)
  WHERE status IN ('open','finalizing') AND channel_account_id IS NOT NULL;

-- A prompt is published for an agent, so only one channel can be training or
-- finalizing that agent at a time. This also prevents two jobs from using
-- incompatible base prompt and dataset snapshots.
CREATE UNIQUE INDEX training_sessions_one_active_agent
  ON training_sessions(agent_profile_id)
  WHERE status IN ('open','finalizing') AND channel_account_id IS NOT NULL;

COMMIT;
