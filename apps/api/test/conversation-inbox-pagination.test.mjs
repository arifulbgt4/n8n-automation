import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, query, sha256 } from "@n8n-automation/core";
import { conversationRoutes } from "../src/routes/conversations.ts";
import { ApiError, jsonError } from "../src/lib.ts";

test("conversation inbox filters by channel and activity window and paginates with a stable total", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const app = Fastify();
  const suffix = randomUUID();
  let tenantId;
  let userId;
  try {
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      if (error?.name === "ZodError") return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed." } });
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await conversationRoutes(app);
    await app.ready();

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`conversation-inbox-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Conversation inbox test',$1) RETURNING id", [`conversation-inbox-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Inbox business',$2) RETURNING id", [tenantId, `inbox-${suffix}`])).rows[0].id;
    const facebookId = (await query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'facebook','Facebook Page',$3) RETURNING id", [tenantId, businessId, `inbox-fb-${suffix}`])).rows[0].id;
    const whatsappId = (await query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id) VALUES($1,$2,'whatsapp','WhatsApp Business',$3) RETURNING id", [tenantId, businessId, `inbox-wa-${suffix}`])).rows[0].id;
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    const sessionToken = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [userId, sha256(sessionToken), sha256(randomUUID())]);
    const headers = { cookie: `n8nauto_session=${sessionToken}` };

    async function addConversation(channelId, contactKey, hoursAgo) {
      const contactId = (await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id,display_name) VALUES($1,$2,$3,$4,$5) RETURNING id", [tenantId, businessId, channelId, `${contactKey}-${suffix}`, contactKey])).rows[0].id;
      const conversationId = (await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,status) VALUES($1,$2,$3,$4,'open') RETURNING id", [tenantId, businessId, channelId, contactId])).rows[0].id;
      await query("UPDATE conversations SET last_message_at=now()-($2::int*interval '1 hour') WHERE id=$1", [conversationId, hoursAgo]);
      return conversationId;
    }
    const recentFacebook = await addConversation(facebookId, "Recent Facebook A", 2);
    const recentFacebookTie = await addConversation(facebookId, "Recent Facebook B", 2);
    await query("UPDATE conversations SET last_message_at=now()-interval '2 hours' WHERE id=ANY($1::uuid[])", [[recentFacebook, recentFacebookTie]]);
    await addConversation(facebookId, "Yesterday Facebook", 30);
    await addConversation(facebookId, "Older Facebook", 24 * 8);
    await addConversation(whatsappId, "Recent WhatsApp", 1);

    const route = `/v1/tenants/${tenantId}/conversations`;
    const lastDay = await app.inject({ method: "GET", url: `${route}?channelId=${facebookId}&period=24h&limit=25&offset=0`, headers });
    assert.equal(lastDay.statusCode, 200, lastDay.body);
    assert.equal(lastDay.json().total, 2);
    assert.deepEqual(lastDay.json().conversations.map((row) => row.id).sort(), [recentFacebook, recentFacebookTie].sort());

    const lastWeek = await app.inject({ method: "GET", url: `${route}?channelId=${facebookId}&period=7d&limit=25&offset=0`, headers });
    assert.equal(lastWeek.statusCode, 200, lastWeek.body);
    assert.equal(lastWeek.json().total, 3);

    const firstPage = await app.inject({ method: "GET", url: `${route}?limit=1&offset=0`, headers });
    const secondPage = await app.inject({ method: "GET", url: `${route}?limit=1&offset=1`, headers });
    const thirdPage = await app.inject({ method: "GET", url: `${route}?limit=1&offset=2`, headers });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    assert.equal(secondPage.statusCode, 200, secondPage.body);
    assert.equal(thirdPage.statusCode, 200, thirdPage.body);
    assert.equal(secondPage.json().total, 5);
    assert.equal(secondPage.json().conversations.length, 1);
    const tiedIdsDescending = [recentFacebook, recentFacebookTie].sort().reverse();
    assert.equal(secondPage.json().conversations[0].id, tiedIdsDescending[0]);
    assert.equal(thirdPage.json().conversations[0].id, tiedIdsDescending[1]);

    const invalidPeriod = await app.inject({ method: "GET", url: `${route}?period=30d`, headers });
    assert.equal(invalidPeriod.statusCode, 400);
  } finally {
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
    await closeDb();
  }
});
