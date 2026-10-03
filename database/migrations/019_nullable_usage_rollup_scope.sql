-- Usage events may be platform-wide or business-wide and therefore have no
-- channel_account_id. Replace the composite primary key with null-safe unique
-- scope semantics; migration 020 removes the PK-generated NOT NULL flags.
ALTER TABLE usage_rollups DROP CONSTRAINT IF EXISTS usage_rollups_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS usage_rollups_scope_bucket_unique
  ON usage_rollups(tenant_id,business_id,channel_account_id,bucket_start,bucket_size,event_type)
  NULLS NOT DISTINCT;
