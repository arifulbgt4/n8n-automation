import type pg from "pg";
import { createHash } from "node:crypto";

type TrainingEvent = {
  id: string;
  conversation_id: string;
  direction: "CONTACT" | "HUMAN";
  text_content: string;
  event_at: Date;
};

export async function captureTrainingMessage(client: pg.PoolClient, input: {
  tenantId: string;
  businessId: string;
  channelId: string;
  conversationId: string;
  sourceMessageId: string;
  platformMessageId: string;
  direction: "CONTACT" | "HUMAN";
  text: string | null | undefined;
  providerTimestamp: string | null | undefined;
}): Promise<boolean> {
  if (!input.providerTimestamp || !input.platformMessageId) return false;
  const eventAt = new Date(input.providerTimestamp);
  if (!Number.isFinite(eventAt.getTime())) return false;
  const session = await client.query<{ id: string }>(`
    SELECT id FROM training_sessions
    WHERE tenant_id=$1 AND business_id=$2 AND channel_account_id=$3
      AND $4::timestamptz<=clock_timestamp()
      AND created_at<=$4 AND (stopped_at IS NULL OR $4<date_trunc('milliseconds',stopped_at))
    ORDER BY created_at DESC LIMIT 1 FOR UPDATE
  `, [input.tenantId, input.businessId, input.channelId, eventAt]);
  if (!session.rows[0]) return false;
  const inserted = await client.query(`
    INSERT INTO training_session_messages(
      tenant_id,business_id,channel_account_id,training_session_id,conversation_id,
      source_message_id,platform_message_id,direction,text_content,event_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT(training_session_id,direction,platform_message_id) DO NOTHING
    RETURNING id
  `, [input.tenantId,input.businessId,input.channelId,session.rows[0].id,input.conversationId,
      input.sourceMessageId,input.platformMessageId,input.direction,input.text?.trim()??"",eventAt]);
  // Webhooks can arrive out of provider order, including after the session
  // closes. Either side may complete or change a customer/reply pair.
  if (inserted.rows[0]) await syncTrainingExamples(client, session.rows[0].id);
  return Boolean(inserted.rows[0]);
}

export function groupTrainingEvents(events: TrainingEvent[]) {
  const pairs: Array<{
    conversationId:string;inputEventId:string;customerEventIds:string[];humanEventIds:string[];
    inputText:string;idealResponse:string;
  }> = [];
  const sorted=events.filter(event=>event.text_content.trim()).sort((a,b)=>
    a.conversation_id.localeCompare(b.conversation_id)
    || new Date(a.event_at).getTime()-new Date(b.event_at).getTime()
    || a.id.localeCompare(b.id));
  let conversationId="";
  let customer:TrainingEvent[]=[];
  let human:TrainingEvent[]=[];
  const flush=()=>{
    if(customer.length&&human.length)pairs.push({
      conversationId,inputEventId:customer[0].id,
      customerEventIds:customer.map(event=>event.id),humanEventIds:human.map(event=>event.id),
      inputText:customer.map(event=>event.text_content).join("\n"),
      idealResponse:human.map(event=>event.text_content).join("\n"),
    });
  };
  for(const event of sorted){
    if(event.conversation_id!==conversationId){flush();conversationId=event.conversation_id;customer=[];human=[];}
    if(event.direction==="CONTACT"){
      if(human.length){flush();customer=[];human=[];}
      customer.push(event);
    }else if(customer.length){human.push(event);}
  }
  flush();
  return pairs;
}

export async function syncTrainingExamples(client: pg.PoolClient, sessionId: string): Promise<number> {
  const session = await client.query<{ tenant_id: string; agent_profile_id: string }>(
    "SELECT tenant_id,agent_profile_id FROM training_sessions WHERE id=$1 FOR SHARE", [sessionId],
  );
  if (!session.rows[0]) return 0;
  const events = await client.query<TrainingEvent>(`
    SELECT id,conversation_id,direction,text_content,event_at
    FROM training_session_messages WHERE training_session_id=$1
    ORDER BY conversation_id,event_at,id
  `, [sessionId]);
  const pairs=groupTrainingEvents(events.rows);
  type PriorExample={id:string;approval_status:"approved"|"pending"|"rejected";input_json:any};
  const prior = await client.query<PriorExample>(`
    SELECT id,approval_status,input_json FROM training_examples
    WHERE training_session_id=$1 AND source='native_channel_training' FOR UPDATE
  `,[sessionId]);
  const priorByInputId=new Map<string,PriorExample>();
  const priorByEventId=new Map<string,PriorExample[]>();
  const reviewRank={approved:0,pending:1,rejected:2};
  for(const example of prior.rows){
    const provenance=example.input_json??{};
    if(typeof provenance.inputEventId==="string")priorByInputId.set(provenance.inputEventId,example);
    for(const eventId of new Set([
      ...(Array.isArray(provenance.customerEventIds)?provenance.customerEventIds:[]),
      ...(Array.isArray(provenance.humanEventIds)?provenance.humanEventIds:[]),
      provenance.inputEventId,
    ].filter((id):id is string=>typeof id==="string"))){
      const examples=priorByEventId.get(eventId)??[];
      examples.push(example);
      priorByEventId.set(eventId,examples);
    }
  }
  const pairIds:string[]=[];
  const usedPriorIds=new Set<string>();
  for(const pair of pairs){
    const provenance={inputEventId:pair.inputEventId,customerEventIds:pair.customerEventIds,
      humanEventIds:pair.humanEventIds,conversationId:pair.conversationId};
    const pairEventIds=new Set([...pair.customerEventIds,...pair.humanEventIds]);
    const overlapping=[...new Set([...pairEventIds].flatMap(id=>priorByEventId.get(id)??[]))];
    // If a late event merges previously reviewed pairs, the strictest prior
    // decision applies to the combined evidence.
    const approvalStatus=overlapping.some(example=>example.approval_status==="rejected")?"rejected"
      :overlapping.some(example=>example.approval_status==="pending")?"pending":"approved";
    const exact=priorByInputId.get(pair.inputEventId);
    const existing=exact&&!usedPriorIds.has(exact.id)?exact:overlapping
      .filter(example=>!usedPriorIds.has(example.id))
      .sort((a,b)=>reviewRank[b.approval_status]-reviewRank[a.approval_status]
        || a.id.localeCompare(b.id))[0];
    if(existing){
      await client.query(`UPDATE training_examples SET input_text=$2,ideal_response=$3,input_json=$4::jsonb,
        approval_status=$5,updated_at=now() WHERE id=$1`,
        [existing.id,pair.inputText,pair.idealResponse,JSON.stringify(provenance),approvalStatus]);
      pairIds.push(existing.id);
      usedPriorIds.add(existing.id);
    }else{
      // A delayed webhook can change a pair's first customer event. Preserve
      // review decisions for overlapping evidence instead of approving it again.
      const created=await client.query<{id:string}>(`INSERT INTO training_examples(
        tenant_id,training_session_id,agent_profile_id,source,input_text,ideal_response,input_json,labels,approval_status
      ) VALUES($1,$2,$3,'native_channel_training',$4,$5,$6::jsonb,ARRAY['native_training'],$7) RETURNING id`,
        [session.rows[0].tenant_id,sessionId,session.rows[0].agent_profile_id,pair.inputText,pair.idealResponse,JSON.stringify(provenance),approvalStatus]);
      pairIds.push(created.rows[0].id);
    }
  }
  await client.query(`DELETE FROM training_examples
    WHERE training_session_id=$1 AND source='native_channel_training' AND NOT (id=ANY($2::uuid[]))`,
    [sessionId,pairIds]);
  return pairs.length;
}

// A candidate must represent the exact approved examples and native event
// windows it saw. A late webhook can change a closed session after synthesis.
export async function trainingDatasetState(
  db: Pick<pg.PoolClient,"query">,
  tenantId: string,
  agentId: string,
  lockSessions = false,
  source: "all" | "native_channel_training" = "all",
) {
  // Publication holds these locks until commit; capture takes FOR UPDATE on
  // the same session. Creation does not lock all sessions, avoiding two OFF
  // requests on different channels waiting on each other's session rows.
  if (lockSessions) await db.query(`SELECT id FROM training_sessions
    WHERE tenant_id=$1 AND agent_profile_id=$2 AND channel_account_id IS NOT NULL
    ORDER BY id FOR SHARE`,[tenantId,agentId]);
  const examples = await db.query<{
    id:string;source:string;input_text:string|null;ideal_response:string;input_json:unknown;labels:string[];
  }>(`SELECT id,source,input_text,ideal_response,input_json,labels
    FROM training_examples WHERE tenant_id=$1 AND agent_profile_id=$2 AND approval_status='approved'
      AND ($3::text='all' OR source=$3)
    ORDER BY id`,[tenantId,agentId,source]);
  const sessions = await db.query<{id:string;event_count:number}>(`
    SELECT ts.id,count(sm.id)::int AS event_count FROM training_sessions ts
    LEFT JOIN training_session_messages sm ON sm.training_session_id=ts.id
    WHERE ts.tenant_id=$1 AND ts.agent_profile_id=$2 AND ts.channel_account_id IS NOT NULL
    GROUP BY ts.id ORDER BY ts.id
  `,[tenantId,agentId]);
  return {
    exampleIds:examples.rows.map(row=>row.id),
    datasetDigest:createHash("sha256").update(JSON.stringify({examples:examples.rows,sessions:sessions.rows})).digest("hex"),
  };
}

export async function restoreTrainingConversations(client: pg.PoolClient, sessionId: string, channelId: string): Promise<string[]> {
  const restored = await client.query<{id:string}>(`
    UPDATE conversations SET mode='AI',state_version=state_version+1,
      escalation_metadata=escalation_metadata-'trainingAutoHumanSessionId',updated_at=now()
    WHERE channel_account_id=$1 AND status='open' AND mode='HUMAN'
      AND escalation_metadata->>'trainingAutoHumanSessionId'=$2
    RETURNING id
  `,[channelId,sessionId]);
  return restored.rows.map(row=>row.id);
}

export async function releaseFinalizingMessages(client: pg.PoolClient, channelId: string, stoppedAt: Date): Promise<string[]> {
  const released = await client.query<{conversation_id:string}>(`
    UPDATE messages SET metadata=metadata-'trainingSuppressed',updated_at=now()
    WHERE channel_account_id=$1 AND direction='INBOUND' AND sender_type='CONTACT'
      AND created_at >= $2 AND metadata->>'trainingSuppressed'='true'
      AND NOT EXISTS (SELECT 1 FROM training_session_messages sm WHERE sm.source_message_id=messages.id)
    RETURNING conversation_id
  `,[channelId,stoppedAt]);
  return [...new Set(released.rows.map(row=>row.conversation_id))];
}

export async function queueResumedTrainingMessages(client: pg.PoolClient, session: {
  id:string;tenant_id:string;business_id:string;channel_account_id:string;stopped_at:Date;
}): Promise<number> {
  const pending = await client.query<{conversation_id:string}>(`
    SELECT DISTINCT m.conversation_id FROM messages m
    JOIN conversations cv ON cv.id=m.conversation_id AND cv.tenant_id=m.tenant_id
    WHERE m.channel_account_id=$1 AND m.created_at >= $2
      AND m.direction='INBOUND' AND m.sender_type='CONTACT' AND m.turn_id IS NULL
      AND COALESCE(m.metadata->>'trainingSuppressed','false')<>'true'
      AND NOT EXISTS (SELECT 1 FROM training_session_messages sm WHERE sm.source_message_id=m.id)
      AND cv.mode='AI' AND cv.status='open'
  `,[session.channel_account_id,session.stopped_at]);
  for (const row of pending.rows) {
    await client.query(`INSERT INTO outbox_events(tenant_id,event_type,business_id,resource_type,resource_id,payload)
      VALUES($1,'TRAINING_RESUME_INBOUND',$2,'conversation',$3,$4::jsonb)`,
      [session.tenant_id,session.business_id,row.conversation_id,
        JSON.stringify({sessionId:session.id,channelAccountId:session.channel_account_id,conversationId:row.conversation_id})]);
  }
  return pending.rows.length;
}
