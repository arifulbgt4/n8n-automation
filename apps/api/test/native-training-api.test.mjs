import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, closeQueues, encryptSecret, query, sha256 } from "@n8n-automation/core";
import { trainingSessionRoutes } from "../src/routes/training-sessions.ts";
import { webhookRoutes } from "../src/routes/webhooks.ts";
import { internalRoutes } from "../src/routes/internal.ts";
import { aiRoutes } from "../src/routes/ai.ts";

test("Training ON/OFF captures native Page replies and later sessions reuse approved examples", {skip:!process.env.DATABASE_URL||!process.env.REDIS_URL}, async () => {
  const app=Fastify();
  let tenantId;
  let userId;
  const originalFetch=globalThis.fetch;
  const suffix=randomUUID();
  process.env.META_APP_ID="app-123";
  process.env.META_APP_SECRET="native-training-test-meta-secret";
  globalThis.fetch=async input=>{
    assert.match(String(input),/graph\.facebook\.com/);
    return new Response(JSON.stringify({data:[{id:"app-123",subscribed_fields:["messages","message_deliveries","message_reads","message_echoes"]}]}),{status:200});
  };
  try {
    await app.register(cookie);
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json",{parseAs:"buffer"},(request,body,done)=>{
      request.rawBody=body;
      try{done(null,JSON.parse(body.toString("utf8")))}catch(error){done(error)}
    });
    await trainingSessionRoutes(app);
    await webhookRoutes(app);
    await internalRoutes(app);
    await aiRoutes(app);
    await app.ready();

    userId=(await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id",[`native-${suffix}@example.test`])).rows[0].id;
    tenantId=(await query("INSERT INTO tenants(name,slug) VALUES('Native training test',$1) RETURNING id",[`native-${suffix}`])).rows[0].id;
    const businessId=(await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Test','business') RETURNING id",[tenantId])).rows[0].id;
    const agentId=(await query("INSERT INTO agent_profiles(tenant_id,business_id,name,capabilities) VALUES($1,$2,'Page agent',ARRAY['FOLLOW_UP']) RETURNING id",[tenantId,businessId])).rows[0].id;
    const promptId=(await query("INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,status) VALUES($1,$2,1,'active') RETURNING id",[tenantId,agentId])).rows[0].id;
    await query("UPDATE agent_profiles SET active_prompt_version_id=$2 WHERE id=$1",[agentId,promptId]);
    const pageId=`page-${suffix}`;
    const channelId=(await query(`INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id)
      VALUES($1,$2,'facebook','Page',$3,$4) RETURNING id`,[tenantId,businessId,pageId,agentId])).rows[0].id;
    const contactId=(await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'customer-1') RETURNING id",[tenantId,businessId,channelId])).rows[0].id;
    const conversationId=(await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id) VALUES($1,$2,$3,$4,'AI',$5) RETURNING id",[tenantId,businessId,channelId,contactId,agentId])).rows[0].id;
    const oldTurnId=(await query("INSERT INTO conversation_turns(tenant_id,conversation_id,speaker) VALUES($1,$2,'CONTACT') RETURNING id",[tenantId,conversationId])).rows[0].id;
    await query("INSERT INTO channel_credentials(tenant_id,channel_account_id,credential_type,encrypted_value) VALUES($1,$2,'access_token',$3)",
      [tenantId,channelId,encryptSecret("test-page-token")]);
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,userId]);
    const sessionToken=randomUUID();
    const csrf=randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [userId,sha256(sessionToken),sha256(csrf)]);
    const authHeaders={cookie:`n8nauto_session=${sessionToken}`,"x-csrf-token":csrf};
    const route=`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions`;
    const post=async(url,body,headers=authHeaders)=>app.inject({method:"POST",url,headers:{"content-type":"application/json",...headers},payload:JSON.stringify(body)});
    const webhook=async(mid,text,isEcho=false,timestamp=Date.now())=>{
      const payload=JSON.stringify({object:"page",entry:[{id:pageId,messaging:[{
        sender:{id:isEcho?pageId:"customer-1"},recipient:{id:isEcho?"customer-1":pageId},timestamp,
        message:{mid,text,...(isEcho?{is_echo:true,app_id:263902037430900}:{})},
      }]}]});
      const signature=`sha256=${createHmac("sha256",process.env.META_APP_SECRET).update(payload).digest("hex")}`;
      return app.inject({method:"POST",url:"/webhooks/meta",headers:{"content-type":"application/json","x-hub-signature-256":signature},payload});
    };

    const firstOn=await post(route,{channelAccountId:channelId});
    assert.equal(firstOn.statusCode,201,firstOn.body);
    const firstId=firstOn.json().session.id;
    const repeatedOn=await post(route,{channelAccountId:channelId});
    assert.equal(repeatedOn.statusCode,409,repeatedOn.body);
    await new Promise(resolve=>setTimeout(resolve,15));
    const firstEventAt=Date.now();
    assert.equal((await webhook(`q1-${suffix}`,"First customer question",false,firstEventAt)).statusCode,200);
    assert.equal((await webhook(`a1-${suffix}`,"First native answer",true,firstEventAt+1)).statusCode,200);
    const conversation=(await query("SELECT id,mode FROM conversations WHERE channel_account_id=$1 LIMIT 1",[channelId])).rows[0];
    assert.equal(conversation.mode,"AI");
    const aiOutbound=()=>post("/v1/internal/outbound/enqueue",{
      tenantId,businessId,channelAccountId:channelId,conversationId:conversation.id,
      messages:[{type:"text",text:"Automated reply"}],senderType:"AI",
    },{authorization:`Bearer ${process.env.INTERNAL_SERVICE_AUTH_SECRET}`});
    assert.equal((await aiOutbound()).statusCode,409);
    await new Promise(resolve=>setTimeout(resolve,15));
    const firstOff=await post(`${route}/${firstId}/stop`,{});
    assert.equal(firstOff.statusCode,200,firstOff.body);
    assert.ok(firstOff.json().trainingJobId);
    assert.equal((await aiOutbound()).statusCode,202);
    const oldAction=await post("/v1/internal/actions/execute",{
      tenantId,businessId,channelAccountId:channelId,conversationId,
      tool:"schedule_followup",arguments:{message:"Old automated follow-up"},
      idempotencyKey:`turn:${oldTurnId}:action:0:schedule_followup`,
    },{authorization:`Bearer ${process.env.INTERNAL_SERVICE_AUTH_SECRET}`});
    assert.equal(oldAction.statusCode,409,oldAction.body);
    const repeatedOff=await post(`${route}/${firstId}/stop`,{});
    assert.equal(repeatedOff.statusCode,200,repeatedOff.body);
    assert.equal(repeatedOff.json().trainingJobId,firstOff.json().trainingJobId);
    const firstDataset=await query("SELECT input_snapshot FROM training_jobs WHERE id=$1",[firstOff.json().trainingJobId]);
    assert.equal(firstDataset.rows[0].input_snapshot.exampleIds.length,1);
    assert.equal(firstDataset.rows[0].input_snapshot.publishPolicy,"manual");
    const active=await query("SELECT active_prompt_version_id FROM agent_profiles WHERE id=$1",[agentId]);
    assert.equal(active.rows[0].active_prompt_version_id,promptId);

    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal((await webhook(`after-${suffix}`,"After OFF question")).statusCode,200);
    const captured=await query("SELECT count(*)::int AS count FROM training_session_messages WHERE training_session_id=$1",[firstId]);
    assert.equal(captured.rows[0].count,2);
    assert.equal((await webhook(`late-q-${suffix}`,"Earlier follow-up",false,firstEventAt+2)).statusCode,200);
    assert.equal((await webhook(`late-a-${suffix}`,"Earlier follow-up answer",true,firstEventAt+3)).statusCode,200);
    const lateCaptured=await query("SELECT count(*)::int AS count FROM training_session_messages WHERE training_session_id=$1",[firstId]);
    assert.equal(lateCaptured.rows[0].count,4);
    const stalePrompt=(await query(`INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,source,status,training_job_id)
      VALUES($1,$2,2,'training','candidate',$3) RETURNING id`,[tenantId,agentId,firstOff.json().trainingJobId])).rows[0].id;
    const stalePublish=await post(`/v1/tenants/${tenantId}/agents/${agentId}/prompts/${stalePrompt}/publish`,{});
    assert.equal(stalePublish.statusCode,409,stalePublish.body);

    const secondOn=await post(route,{channelAccountId:channelId});
    assert.equal(secondOn.statusCode,201,secondOn.body);
    const secondId=secondOn.json().session.id;
    await new Promise(resolve=>setTimeout(resolve,15));
    assert.equal((await webhook(`q2-${suffix}`,"Second customer question")).statusCode,200);
    assert.equal((await webhook(`a2-${suffix}`,"Second native answer",true)).statusCode,200);
    await new Promise(resolve=>setTimeout(resolve,15));
    const secondOff=await post(`${route}/${secondId}/stop`,{});
    assert.equal(secondOff.statusCode,200,secondOff.body);
    const secondDataset=await query("SELECT input_snapshot FROM training_jobs WHERE id=$1",[secondOff.json().trainingJobId]);
    assert.equal(secondDataset.rows[0].input_snapshot.exampleIds.length,3);
    assert.notEqual(secondDataset.rows[0].input_snapshot.datasetDigest,firstDataset.rows[0].input_snapshot.datasetDigest);
  } finally {
    globalThis.fetch=originalFetch;
    await app.close();
    if(tenantId)await query("DELETE FROM tenants WHERE id=$1",[tenantId]);
    if(userId)await query("DELETE FROM users WHERE id=$1",[userId]);
    await closeQueues();
    await closeDb();
  }
});
