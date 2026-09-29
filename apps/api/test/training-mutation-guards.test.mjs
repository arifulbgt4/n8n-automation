import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, closeQueues, encryptSecret, query, sha256 } from "@n8n-automation/core";
import { trainingSessionRoutes } from "../src/routes/training-sessions.ts";
import { channelRoutes } from "../src/routes/channels.ts";
import { conversationRoutes } from "../src/routes/conversations.ts";
import { resourceCrudRoutes } from "../src/routes/resource-crud.ts";
import { tenantRoutes } from "../src/routes/tenant.ts";
import { aiRoutes } from "../src/routes/ai.ts";
import { ApiError, jsonError } from "../src/lib.ts";

test("active channel training prevents reassignment, disablement, archive, and AI mode takeover", {
  skip: !process.env.DATABASE_URL || !process.env.REDIS_URL,
}, async () => {
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  const originalMetaAppId = process.env.META_APP_ID;
  const suffix = randomUUID();
  let tenantId;
  let userId;
  let failConnectionTest = false;
  process.env.META_APP_ID = "training-guard-test-app";
  globalThis.fetch = async () => failConnectionTest
    ? new Response(JSON.stringify({error:{message:"Test connection failed"}}),{status:503})
    : new Response(JSON.stringify({data:[{id:"training-guard-test-app",subscribed_fields:["messages","message_deliveries","message_reads","message_echoes"]}]}),{status:200});
  try {
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      reply.code(500).send({error:{code:"TEST_UNHANDLED",message:error.message}});
    });
    await trainingSessionRoutes(app);
    await channelRoutes(app);
    await conversationRoutes(app);
    await resourceCrudRoutes(app);
    await tenantRoutes(app);
    await aiRoutes(app);
    await app.ready();

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id",[`training-guard-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Training guard test',$1) RETURNING id",[`training-guard-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Test','test') RETURNING id",[tenantId])).rows[0].id;
    const agentA = (await query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Agent A') RETURNING id",[tenantId,businessId])).rows[0].id;
    const agentB = (await query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Agent B') RETURNING id",[tenantId,businessId])).rows[0].id;
    for (const agentId of [agentA,agentB]) {
      const promptId = (await query("INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,status) VALUES($1,$2,1,'active') RETURNING id",[tenantId,agentId])).rows[0].id;
      await query("UPDATE agent_profiles SET active_prompt_version_id=$2 WHERE id=$1",[agentId,promptId]);
    }
    const channelId = (await query(`INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id)
      VALUES($1,$2,'facebook','Test Page',$3,$4) RETURNING id`,[tenantId,businessId,`guard-page-${suffix}`,agentA])).rows[0].id;
    await query("INSERT INTO channel_credentials(tenant_id,channel_account_id,credential_type,encrypted_value) VALUES($1,$2,'access_token',$3)",[tenantId,channelId,encryptSecret("test-page-token")]);
    const contactId = (await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'customer') RETURNING id",[tenantId,businessId,channelId])).rows[0].id;
    const conversationId = (await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id) VALUES($1,$2,$3,$4,'HUMAN',$5) RETURNING id",[tenantId,businessId,channelId,contactId,agentA])).rows[0].id;
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,userId]);
    const sessionToken = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[userId,sha256(sessionToken),sha256(csrf)]);
    const headers = {cookie:`n8nauto_session=${sessionToken}`,"x-csrf-token":csrf};
    const request = (method,url,body) => app.inject({method,url,
      headers:{...headers,...(body===undefined?{}:{"content-type":"application/json"})},
      payload:body===undefined?undefined:JSON.stringify(body)});
    const expectTrainingConflict = async (method,url,body) => {
      const response = await request(method,url,body);
      assert.equal(response.statusCode,409,`${method} ${url}: ${response.body}`);
      assert.equal(response.json().error?.code,"CHANNEL_TRAINING_ON");
    };
    const channelRoute = `/v1/tenants/${tenantId}/channels/${channelId}`;
    const agentRoute = `/v1/tenants/${tenantId}/agents/${agentA}`;
    const businessRoute = `/v1/tenants/${tenantId}/businesses/${businessId}`;
    const conversationRoute = `/v1/tenants/${tenantId}/conversations/${conversationId}`;
    const trainingRoute = `${agentRoute}/training-sessions`;

    const on = await request("POST",trainingRoute,{channelAccountId:channelId});
    assert.equal(on.statusCode,201,on.body);
    const trainingId = on.json().session.id;

    await expectTrainingConflict("PATCH",channelRoute,{defaultAgentProfileId:agentB});
    await expectTrainingConflict("PATCH",channelRoute,{active:false});
    await expectTrainingConflict("PATCH",channelRoute,{credentials:{accessToken:"replacement-token"}});
    const rename = await request("PATCH",channelRoute,{name:"Renamed Page"});
    assert.equal(rename.statusCode,200,rename.body);
    await expectTrainingConflict("POST",`${channelRoute}/pause`,{});
    failConnectionTest = true;
    await expectTrainingConflict("POST",`${channelRoute}/test`,{});
    await expectTrainingConflict("POST",`${channelRoute}/reconnect`,{});
    failConnectionTest = false;
    await expectTrainingConflict("DELETE",channelRoute);
    await expectTrainingConflict("DELETE",`${channelRoute}/remove`);
    await expectTrainingConflict("PATCH",agentRoute,{status:"archived"});
    await expectTrainingConflict("DELETE",agentRoute);
    await expectTrainingConflict("PATCH",businessRoute,{status:"paused"});
    await expectTrainingConflict("POST",`${businessRoute}/archive`,{});
    await expectTrainingConflict("DELETE",businessRoute);
    await expectTrainingConflict("POST",`${conversationRoute}/mode`,{mode:"AI"});

    const state = (await query("SELECT active,connection_status,default_agent_profile_id FROM channel_accounts WHERE id=$1",[channelId])).rows[0];
    assert.equal(state.active,true);
    assert.equal(state.connection_status,"connected");
    assert.equal(state.default_agent_profile_id,agentA);
    assert.equal((await query("SELECT mode FROM conversations WHERE id=$1",[conversationId])).rows[0].mode,"HUMAN");

    const off = await request("POST",`${trainingRoute}/${trainingId}/stop`,{});
    assert.equal(off.statusCode,200,off.body);
    const modeAfterOff = await request("POST",`${conversationRoute}/mode`,{mode:"AI"});
    assert.equal(modeAfterOff.statusCode,200,modeAfterOff.body);
    const reassignAfterOff = await request("PATCH",channelRoute,{defaultAgentProfileId:agentB});
    assert.equal(reassignAfterOff.statusCode,200,reassignAfterOff.body);
    const pausedBusiness = await request("PATCH",businessRoute,{status:"paused"});
    assert.equal(pausedBusiness.statusCode,200,pausedBusiness.body);
    const onPausedBusiness = await request("POST",`/v1/tenants/${tenantId}/agents/${agentB}/training-sessions`,{channelAccountId:channelId});
    assert.equal(onPausedBusiness.statusCode,409,onPausedBusiness.body);
    assert.equal(onPausedBusiness.json().error?.code,"BUSINESS_NOT_ACTIVE");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalMetaAppId === undefined) delete process.env.META_APP_ID;
    else process.env.META_APP_ID = originalMetaAppId;
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1",[tenantId]);
    if (userId) await query("DELETE FROM users WHERE id=$1",[userId]);
    await closeQueues();
    await closeDb();
  }
});
