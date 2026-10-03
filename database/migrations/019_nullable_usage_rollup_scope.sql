-- Usage events may be platform-wide or business-wide and therefore have no
-- channel_account_id. Keep those dimensions nullable in rollups and treat
-- NULL scope values as equal for idempotent upserts.
ALTER TABLE usage_rollups DROP CONSTRAINT IF EXISTS usage_rollups_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS usage_rollups_scope_bucket_unique
  ON usage_rollups(tenant_id,business_id,channel_account_id,bucket_start,bucket_size,event_type)
  NULLS NOT DISTINCT;
