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
      AND created_at<=$4 AND (stopped_at IS NULL OR $4<stopped_at)
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
  if (inserted.rows[0] && input.direction === "HUMAN") await syncTrainingExamples(client, session.rows[0].id);
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
  const pairIds:string[]=[];
  for(const pair of pairs){
    const provenance={inputEventId:pair.inputEventId,customerEventIds:pair.customerEventIds,
      humanEventIds:pair.humanEventIds,conversationId:pair.conversationId};
    const existing=await client.query<{id:string}>(`
      SELECT id FROM training_examples WHERE training_session_id=$1 AND source='native_channel_training'
        AND input_json->>'inputEventId'=$2 LIMIT 1
    `,[sessionId,pair.inputEventId]);
    if(existing.rows[0]){
      await client.query(`UPDATE training_examples SET input_text=$2,ideal_response=$3,input_json=$4::jsonb,updated_at=now()
        WHERE id=$1`,[existing.rows[0].id,pair.inputText,pair.idealResponse,JSON.stringify(provenance)]);
      pairIds.push(existing.rows[0].id);
    }else{
      const created=await client.query<{id:string}>(`INSERT INTO training_examples(
        tenant_id,training_session_id,agent_profile_id,source,input_text,ideal_response,input_json,labels,approval_status
      ) VALUES($1,$2,$3,'native_channel_training',$4,$5,$6::jsonb,ARRAY['native_training'],'approved') RETURNING id`,
        [session.rows[0].tenant_id,sessionId,session.rows[0].agent_profile_id,pair.inputText,pair.idealResponse,JSON.stringify(provenance)]);
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
export async function trainingDatasetState(db: Pick<pg.PoolClient,"query">, tenantId: string, agentId: string, lockSessions = false) {
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
    ORDER BY id`,[tenantId,agentId]);
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
