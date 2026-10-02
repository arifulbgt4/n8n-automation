import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, closeQueues, query, sha256 } from "@n8n-automation/core";
import { actionRoutes } from "../src/routes/actions.ts";
import { internalRoutes } from "../src/routes/internal.ts";
import { orchestrationRoutes } from "../src/routes/orchestration.ts";
import { ApiError, jsonError } from "../src/lib.ts";

test("Facebook order action is saved in Business Actions with scoped snapshots and stable retries", {
  skip: !process.env.DATABASE_URL || !process.env.REDIS_URL || process.env.DATABASE_URL.includes("unused:unused"),
}, async () => {
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  const suffix = randomUUID();
  let tenantId;
  let userId;
  let proposedAiResponse;
  let enqueuedResponses = 0;
  try {
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await actionRoutes(app);
    await internalRoutes(app);
    await orchestrationRoutes(app);
    await app.ready();
    // The internal action calls the same public order route the deployed API uses.
    // Route the HTTP call in-process; no external provider or live channel is used.
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, new URL(process.env.API_PUBLIC_ORIGIN || "http://localhost:4000").origin);
      if (url.pathname === "/v1/internal/ai/respond") {
        return new Response(JSON.stringify(proposedAiResponse), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/v1/internal/outbound/enqueue") {
        const saved = await query("SELECT id FROM orders WHERE tenant_id=$1", [tenantId]);
        assert.equal(saved.rows.length, 1, "the order must already be committed before the success reply is enqueued");
        enqueuedResponses++;
      }
      const response = await app.inject({ method: init.method, url: url.pathname, headers: init.headers, payload: init.body });
      return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
    };

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`order-action-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Order action test',$1) RETURNING id", [`order-action-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug,currency) VALUES($1,'Saree shop','main','BDT') RETURNING id", [tenantId])).rows[0].id;
    const otherBusinessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Other shop','other') RETURNING id", [tenantId])).rows[0].id;
    const agentId = (await query("INSERT INTO agent_profiles(tenant_id,business_id,name,capabilities) VALUES($1,$2,'Order agent',ARRAY['ORDER_CREATE']) RETURNING id", [tenantId, businessId])).rows[0].id;
    const channelId = (await query("INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id) VALUES($1,$2,'facebook','Test Page',$3,$4) RETURNING id", [tenantId, businessId, `orders-page-${suffix}`, agentId])).rows[0].id;
    const contactId = (await query("INSERT INTO contacts(tenant_id,business_id,channel_account_id,external_contact_id) VALUES($1,$2,$3,'test-buyer') RETURNING id", [tenantId, businessId, channelId])).rows[0].id;
    const conversationId = (await query("INSERT INTO conversations(tenant_id,business_id,channel_account_id,contact_id,mode,agent_profile_id) VALUES($1,$2,$3,$4,'AI',$5) RETURNING id", [tenantId, businessId, channelId, contactId, agentId])).rows[0].id;
    const turnId = (await query("INSERT INTO conversation_turns(tenant_id,conversation_id,speaker) VALUES($1,$2,'CONTACT') RETURNING id", [tenantId, conversationId])).rows[0].id;
    const collectionId = (await query("INSERT INTO collections(tenant_id,business_id,name,key,purpose) VALUES($1,$2,'Sarees','sarees','products') RETURNING id", [tenantId, businessId])).rows[0].id;
    const itemId = (await query("INSERT INTO collection_items(tenant_id,business_id,collection_id,title,data_jsonb) VALUES($1,$2,$3,'Tangail suti saree',$4::jsonb) RETURNING id", [tenantId, businessId, collectionId, JSON.stringify({ price: 899, stock_qty: 10 })])).rows[0].id;
    const imageId = (await query("INSERT INTO media_assets(tenant_id,business_id,storage_file_id,original_name,mime_type,kind,size_bytes,public_url) VALUES($1,$2,$3,'tangail-saree.png','image/png','image',1024,'https://media.example.test/tangail-saree.png') RETURNING id", [tenantId,businessId,`order-image-${suffix}`])).rows[0].id;
    await query("INSERT INTO collection_item_media(collection_item_id,media_asset_id,tenant_id,role,display_order) VALUES($1,$2,$3,'primary',0)", [itemId,imageId,tenantId]);
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    const sessionToken = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [userId, sha256(sessionToken), sha256(csrf)]);
    const panelHeaders = { cookie: `n8nauto_session=${sessionToken}`, "x-csrf-token": csrf };
    const internalHeaders = { authorization: `Bearer ${process.env.INTERNAL_SERVICE_AUTH_SECRET}`, "content-type": "application/json" };
    const argumentsBody = {
      items: [{ collectionItemId: itemId, title: "Tangail suti saree", quantity: 2, unitPrice: 899, attributes: { color: "Blue" } }],
      customer: { name: "Acceptance test buyer", phone: "test-phone" },
      delivery: { address: "Test address, no fulfillment" },
      source: "panel", // Model-supplied source must not disguise an AI order.
    };
    const action = { tenantId, businessId, channelAccountId: channelId, conversationId, tool: "create_order", arguments: argumentsBody, idempotencyKey: `turn:${turnId}:action:0:create_order` };
    const execute = body => app.inject({ method: "POST", url: "/v1/internal/actions/execute", headers: internalHeaders, payload: JSON.stringify(body) });
    proposedAiResponse = {
      turnId, tenantId, businessId, channelAccountId: channelId, conversationId, stateVersion: 1,
      agentProfileId: agentId, actions: [{ tool: "create_order", arguments: argumentsBody }],
      messages: [{ type: "text", text: "Your acceptance test order is confirmed. No fulfillment." }], handoff: false,
    };
    const first = await app.inject({ method: "POST", url: "/v1/internal/orchestration/turn", headers: internalHeaders, payload: JSON.stringify({ turnId }) });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(enqueuedResponses, 1);
    const firstResult = first.json().actionResults[0];
    const order = firstResult.result.order;
    assert.equal(order.source, "ai");
    assert.equal(order.tenant_id, tenantId);
    assert.equal(order.business_id, businessId);
    assert.equal(order.channel_account_id, channelId);
    assert.equal(order.conversation_id, conversationId);
    assert.equal(order.contact_id, contactId);
    assert.equal(order.currency, "BDT");
    assert.equal(Number(order.total), 1798);
    assert.deepEqual(order.customer_snapshot, argumentsBody.customer);
    assert.deepEqual(order.delivery_metadata, argumentsBody.delivery);
    const retry = await execute(action);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), firstResult);
    const duplicateAction = await execute({ ...action, idempotencyKey: `turn:${turnId}:action:1:create_order` });
    assert.equal(duplicateAction.statusCode, 200, duplicateAction.body);
    assert.deepEqual(duplicateAction.json(), firstResult, "a repeated action at another index must use the same order for this confirmation turn");
    const completedTurn = (await query("SELECT status,metadata FROM conversation_turns WHERE id=$1", [turnId])).rows[0];
    assert.equal(completedTurn.status, "processed");
    assert.equal(completedTurn.metadata.actionCount, 1);

    const panelList = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/orders?businessId=${businessId}&channelId=${channelId}`, headers: panelHeaders });
    assert.equal(panelList.statusCode, 200, panelList.body);
    assert.equal(panelList.json().orders.length, 1);
    const saved = panelList.json().orders[0];
    assert.equal(saved.id, order.id);
    assert.equal(saved.platform, "facebook");
    assert.equal(saved.channel_name, "Test Page");
    assert.equal(saved.items.length, 1);
    assert.equal(saved.items[0].collection_item_id, itemId);
    assert.equal(saved.items[0].title_snapshot, "Tangail suti saree");
    assert.equal(Number(saved.items[0].quantity), 2);
    assert.equal(Number(saved.items[0].unit_price), 899);
    assert.deepEqual(saved.items[0].attributes_snapshot, { color: "Blue" });
    assert.equal(saved.items[0].collection_id, collectionId);
    assert.equal(saved.items[0].collection_name, "Sarees");
    assert.equal(saved.items[0].media[0].id, imageId);
    assert.equal(saved.items[0].media[0].mimeType, "image/png");
    const wrongBusiness = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/orders?businessId=${otherBusinessId}`, headers: panelHeaders });
    assert.equal(wrongBusiness.json().orders.length, 0);
    await query("INSERT INTO collection_items(tenant_id,business_id,collection_id,title,data_jsonb) VALUES($1,$2,$3,'Second catalog item','{}'::jsonb)", [tenantId,businessId,collectionId]);
    const sourceItem = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/collections/${collectionId}/items?itemId=${itemId}`, headers: panelHeaders });
    assert.equal(sourceItem.statusCode, 200, sourceItem.body);
    assert.equal(sourceItem.json().total, 1);
    assert.deepEqual(sourceItem.json().items.map(row => row.id), [itemId]);
    const bookingId = (await query(`INSERT INTO bookings(tenant_id,business_id,channel_account_id,conversation_id,contact_id,collection_item_id,status,starts_at,timezone,customer_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,'requested',now()+interval '1 day','Asia/Dhaka',$7::jsonb) RETURNING id`, [tenantId,businessId,channelId,conversationId,contactId,itemId,JSON.stringify({name:"Test buyer"})])).rows[0].id;
    const bookingList = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/bookings?businessId=${businessId}`, headers: panelHeaders });
    assert.equal(bookingList.statusCode, 200, bookingList.body);
    const savedBooking = bookingList.json().bookings.find(row => row.id === bookingId);
    assert.equal(savedBooking.service_title, "Tangail suti saree");
    assert.equal(savedBooking.service_collection_id, collectionId);
    assert.equal(savedBooking.service_collection_name, "Sarees");
    assert.equal(savedBooking.service_media[0].id, imageId);
    const events = await query("SELECT id FROM outbox_events WHERE tenant_id=$1 AND event_type='ORDER_CREATED' AND resource_id=$2", [tenantId, order.id]);
    assert.equal(events.rows.length, 1);

    const failedTurnId = (await query("INSERT INTO conversation_turns(tenant_id,conversation_id,speaker) VALUES($1,$2,'CONTACT') RETURNING id", [tenantId, conversationId])).rows[0].id;
    proposedAiResponse = { ...proposedAiResponse, turnId: failedTurnId, actions: [{ tool: "create_order", arguments: { ...argumentsBody, items: [{ title: "Invalid item", quantity: 0, unitPrice: 899 }] } }] };
    const failedOrchestration = await app.inject({ method: "POST", url: "/v1/internal/orchestration/turn", headers: internalHeaders, payload: JSON.stringify({ turnId: failedTurnId }) });
    assert.equal(failedOrchestration.statusCode, 500, failedOrchestration.body);
    assert.equal(enqueuedResponses, 1, "a failed action must not enqueue its order-success reply");
    assert.equal((await query("SELECT status FROM conversation_turns WHERE id=$1", [failedTurnId])).rows[0].status, "failed");
    assert.equal((await query("SELECT id FROM orders WHERE tenant_id=$1", [tenantId])).rows.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
    await closeDb();
    await closeQueues();
  }
});

test("order retries are safe under concurrency and completion-record failure", {
  skip: !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("unused:unused"),
}, async () => {
  const app = Fastify();
  const suffix = randomUUID().replaceAll("-", "");
  const trigger = `test_order_claim_${suffix}`;
  let tenantId;
  try {
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await actionRoutes(app);
    await app.ready();
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Order retry race test',$1) RETURNING id", [`order-race-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Retry business','retry') RETURNING id", [tenantId])).rows[0].id;
    // Delay only this test tenant's first claim. All concurrent requests finish
    // their initial reads before the INSERT commits, deterministically exposing
    // SELECT-then-UPSERT implementations that let several requests do the work.
    await query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.15); RETURN NEW; END $$`);
    await query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON idempotency_keys FOR EACH ROW WHEN (NEW.tenant_id='${tenantId}'::uuid AND NEW.scope='create_order') EXECUTE FUNCTION ${trigger}()`);
    const post = () => app.inject({
      method: "POST", url: `/v1/tenants/${tenantId}/orders`,
      headers: { authorization: `Bearer ${process.env.INTERNAL_SERVICE_AUTH_SECRET}`, "content-type": "application/json", "idempotency-key": `order-race-${suffix}` },
      payload: JSON.stringify({ businessId, items: [{ title: "Retry product", quantity: 1, unitPrice: 899 }] }),
    });
    const attempts = await Promise.all(Array.from({ length: 8 }, post));
    assert.ok(attempts.some(response => response.statusCode === 201), attempts.map(response => response.body).join("\n"));
    assert.ok(attempts.every(response => [201, 409].includes(response.statusCode)), attempts.map(response => response.body).join("\n"));
    const rows = await query("SELECT id FROM orders WHERE tenant_id=$1", [tenantId]);
    assert.equal(rows.rows.length, 1, "concurrent retries must save exactly one order");
    const retry = await post();
    assert.equal(retry.statusCode, 201, retry.body);
    assert.equal(retry.json().order.id, rows.rows[0].id);
    assert.equal((await query("SELECT id FROM outbox_events WHERE tenant_id=$1 AND event_type='ORDER_CREATED'", [tenantId])).rows.length, 1);

    await query(`DROP TRIGGER ${trigger} ON idempotency_keys`);
    await query(`DROP FUNCTION ${trigger}()`);
    await query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated completion failure'; END $$`);
    await query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON idempotency_keys FOR EACH ROW WHEN (NEW.tenant_id='${tenantId}'::uuid AND NEW.scope='create_order' AND NEW.status='completed') EXECUTE FUNCTION ${trigger}()`);
    const failedKey = `order-completion-${suffix}`;
    const failedPost = () => app.inject({
      method: "POST", url: `/v1/tenants/${tenantId}/orders`,
      headers: { authorization: `Bearer ${process.env.INTERNAL_SERVICE_AUTH_SECRET}`, "content-type": "application/json", "idempotency-key": failedKey },
      payload: JSON.stringify({ businessId, items: [{ title: "Completion retry product", quantity: 1, unitPrice: 199 }] }),
    });
    const failedCompletion = await failedPost();
    assert.equal(failedCompletion.statusCode, 500, failedCompletion.body);
    assert.equal((await query("SELECT id FROM orders WHERE tenant_id=$1", [tenantId])).rows.length, 1, "the failed completion record rolls back the new order");
    assert.equal((await query("SELECT id FROM outbox_events WHERE tenant_id=$1 AND event_type='ORDER_CREATED'", [tenantId])).rows.length, 1, "its outbox event also rolls back");
    assert.equal((await query("SELECT status FROM idempotency_keys WHERE tenant_id=$1 AND scope='create_order' AND key=$2", [tenantId, failedKey])).rows[0].status, "failed");
    await query(`DROP TRIGGER ${trigger} ON idempotency_keys`);
    const successfulRetry = await failedPost();
    assert.equal(successfulRetry.statusCode, 201, successfulRetry.body);
    const afterRetry = await failedPost();
    assert.equal(afterRetry.statusCode, 201, afterRetry.body);
    assert.equal(afterRetry.json().order.id, successfulRetry.json().order.id);
    assert.equal((await query("SELECT id FROM orders WHERE tenant_id=$1", [tenantId])).rows.length, 2);
    assert.equal((await query("SELECT id FROM outbox_events WHERE tenant_id=$1 AND event_type='ORDER_CREATED'", [tenantId])).rows.length, 2);
  } finally {
    await query(`DROP TRIGGER IF EXISTS ${trigger} ON idempotency_keys`);
    await query(`DROP FUNCTION IF EXISTS ${trigger}()`);
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    await closeDb();
  }
});
