BEGIN;

ALTER TABLE training_sessions
  ADD COLUMN channel_account_id uuid REFERENCES channel_accounts(id) ON DELETE CASCADE,
  ADD COLUMN stopped_at timestamptz,
  ADD COLUMN candidate_training_job_id uuid REFERENCES training_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX training_sessions_one_open_channel
  ON training_sessions(channel_account_id)
  WHERE status='open' AND channel_account_id IS NOT NULL;

CREATE INDEX training_sessions_channel_window
  ON training_sessions(channel_account_id,created_at,stopped_at)
  WHERE channel_account_id IS NOT NULL;

CREATE TABLE training_session_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  training_session_id uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  source_message_id uuid,
  platform_message_id text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('CONTACT','HUMAN')),
  text_content text NOT NULL,
  event_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (training_session_id, direction, platform_message_id)
);

CREATE INDEX training_session_messages_order
  ON training_session_messages(training_session_id,conversation_id,event_at,id);

CREATE INDEX training_session_messages_provider_lookup
  ON training_session_messages(channel_account_id,platform_message_id,direction);

-- Training examples outlive a session's operational metadata and message cache.
ALTER TABLE training_examples DROP CONSTRAINT training_examples_training_session_id_fkey;
ALTER TABLE training_examples ADD CONSTRAINT training_examples_training_session_id_fkey
  FOREIGN KEY (training_session_id) REFERENCES training_sessions(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX training_examples_native_pair_unique
  ON training_examples(training_session_id,(input_json->>'inputEventId'))
  WHERE source='native_channel_training' AND training_session_id IS NOT NULL;

COMMIT;
