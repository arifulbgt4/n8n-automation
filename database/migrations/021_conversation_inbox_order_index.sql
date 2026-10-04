-- Keep the tenant-wide inbox sorted by recent activity without blocking writes
-- while the index is built on an existing production database.
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_inbox_order_idx
  ON conversations(tenant_id, status, last_message_at DESC NULLS LAST, id DESC);
