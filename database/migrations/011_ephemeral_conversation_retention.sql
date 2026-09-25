BEGIN;

-- Conversation messages are an operational rolling cache, not a permanent archive.
-- Keep only the newest 20 messages per conversation. Long-term counters live in
-- usage_events / analytics rollups instead of the raw messages table.
CREATE OR REPLACE FUNCTION trim_conversation_message_window()
RETURNS trigger AS $$
BEGIN
  DELETE FROM messages m
  WHERE m.conversation_id = NEW.conversation_id
    AND m.id IN (
      SELECT candidate.id
      FROM messages AS candidate
      WHERE candidate.conversation_id = NEW.conversation_id
      ORDER BY candidate.created_at DESC, candidate.id DESC
      OFFSET 20
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_keep_recent_window ON messages;
CREATE TRIGGER messages_keep_recent_window
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION trim_conversation_message_window();

-- Apply the rolling window immediately to existing data.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY conversation_id ORDER BY created_at DESC, id DESC) AS rn
  FROM messages
)
DELETE FROM messages m
USING ranked r
WHERE m.id = r.id AND r.rn > 20;

-- Conversation attachments are not reusable tenant media. Hide legacy inbound
-- attachments from Media Library immediately. The runtime purge process removes
-- the physical Media Storage files and rows safely after deployment.
UPDATE media_assets
SET processing_status='deleted',
    metadata=COALESCE(metadata,'{}'::jsonb)||'{"retention":"conversation_ephemeral"}'::jsonb,
    updated_at=now()
WHERE metadata->>'source'='inbound_message'
  AND processing_status<>'deleted';

-- Provider URLs/IDs are short-lived processing references. Old completed turns
-- should not retain them indefinitely in PostgreSQL.
UPDATE messages m
SET metadata=(COALESCE(m.metadata,'{}'::jsonb)
              - 'providerMediaId'
              - 'providerMediaUrl'
              - 'attachments'
              - 'providerMimeType'
              - 'providerFilename')
             || jsonb_build_object('mediaIngestStatus','discarded'),
    updated_at=now()
WHERE m.turn_id IS NOT NULL
  AND m.message_type IN ('image','audio','video','document')
  AND EXISTS (
    SELECT 1 FROM conversation_turns t
    WHERE t.id=m.turn_id AND t.status IN ('processed','failed')
  );

COMMIT;
