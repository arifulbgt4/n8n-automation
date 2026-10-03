-- Dropping a primary key does not clear the NOT NULL flags PostgreSQL added
-- to its columns. Allow platform- and business-scoped usage rollups explicitly.
ALTER TABLE usage_rollups
  ALTER COLUMN business_id DROP NOT NULL,
  ALTER COLUMN channel_account_id DROP NOT NULL;
