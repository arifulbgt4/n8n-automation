-- Support channel-specific inbox filters and stable page ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_inbox_channel_idx
  ON conversations(tenant_id, channel_account_id, status, last_message_at DESC NULLS LAST, id DESC);
