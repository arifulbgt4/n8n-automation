type SqlClient = {
  query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ id: string }> }>;
};

export class ProviderOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutcomeUnknownError";
  }
}

export function humanReplyOutcomeUnknown(error: unknown, acceptedProviderMessageId: string | null): boolean {
  return error instanceof ProviderOutcomeUnknownError || Boolean(acceptedProviderMessageId);
}

// Called only after the channel provider accepts a Customer Panel human reply.
// The caller holds the channel row lock, which Training OFF also takes before
// closing the session and assembling its snapshot.
export async function capturePanelTrainingReply(db: SqlClient, input: {
  tenantId: string;
  businessId: string;
  channelId: string;
  conversationId: string;
  sessionId: string | null | undefined;
  sourceMessageId: string;
}): Promise<boolean> {
  if (!input.sessionId) return false;
  const inserted = await db.query(`
    INSERT INTO training_session_messages(
      tenant_id,business_id,channel_account_id,training_session_id,conversation_id,
      source_message_id,platform_message_id,direction,text_content,event_at
    )
    SELECT $1,$2,$3,ts.id,$4,m.id,m.platform_message_id,
      'HUMAN',btrim(m.text_content),m.provider_timestamp
    FROM training_sessions ts
    JOIN messages m ON m.id=$6 AND m.tenant_id=$1 AND m.business_id=$2
      AND m.channel_account_id=$3 AND m.conversation_id=$4
    WHERE ts.id=$5 AND ts.tenant_id=$1 AND ts.business_id=$2
      AND ts.channel_account_id=$3 AND ts.status='open' AND ts.stopped_at IS NULL
      AND m.direction='OUTBOUND' AND m.sender_type='HUMAN'
      AND m.delivery_status='sent' AND m.provider_timestamp>=ts.created_at
      AND m.provider_timestamp<=clock_timestamp()
      AND m.platform_message_id IS NOT NULL AND m.platform_message_id<>''
      AND m.text_content IS NOT NULL AND btrim(m.text_content)<>''
    ON CONFLICT(training_session_id,direction,platform_message_id) DO NOTHING
    RETURNING id
  `, [input.tenantId,input.businessId,input.channelId,input.conversationId,input.sessionId,input.sourceMessageId]);
  return Boolean(inserted.rows[0]);
}
