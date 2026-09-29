import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, query, sha256 } from "@n8n-automation/core";
import { aiRoutes } from "../src/routes/ai.ts";
import { ApiError, jsonError } from "../src/lib.ts";

test("agent collection assignment replaces only same-business active links atomically", {
  skip: !process.env.DATABASE_URL,
}, async () => {
  const app = Fastify();
  const suffix = randomUUID();
  let tenantId;
  let otherTenantId;
  let userId;
  try {
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await aiRoutes(app);
    await app.ready();

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`agent-links-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Agent links test',$1) RETURNING id", [`agent-links-${suffix}`])).rows[0].id;
    otherTenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Other tenant',$1) RETURNING id", [`other-agent-links-${suffix}`])).rows[0].id;
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Main business','main') RETURNING id", [tenantId])).rows[0].id;
    const otherBusinessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Other business','other') RETURNING id", [tenantId])).rows[0].id;
    const crossTenantBusinessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Foreign business','foreign') RETURNING id", [otherTenantId])).rows[0].id;
    const makeCollection = async (ownerTenantId, ownerBusinessId, key, status = "active") =>
      (await query(`INSERT INTO collections(tenant_id,business_id,name,key,status)
        VALUES($1,$2,$3,$3,$4) RETURNING id`, [ownerTenantId, ownerBusinessId, key, status])).rows[0].id;
    const firstId = await makeCollection(tenantId, businessId, "first");
    const secondId = await makeCollection(tenantId, businessId, "second");
    const otherBusinessCollectionId = await makeCollection(tenantId, otherBusinessId, "other");
    const otherTenantCollectionId = await makeCollection(otherTenantId, crossTenantBusinessId, "foreign");
    const archivedId = await makeCollection(tenantId, businessId, "archived", "archived");
    const agentId = (await query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Catalog agent') RETURNING id", [tenantId, businessId])).rows[0].id;
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    const sessionToken = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [userId, sha256(sessionToken), sha256(csrf)]);
    const route = `/v1/tenants/${tenantId}/agents/${agentId}`;
    const headers = { cookie: `n8nauto_session=${sessionToken}`, "x-csrf-token": csrf };
    const patch = (body, requestHeaders = headers) => app.inject({ method: "PATCH", url: route, headers: { "content-type": "application/json", ...requestHeaders }, payload: JSON.stringify(body) });
    const linkedIds = async () => (await query("SELECT collection_id FROM agent_collection_links WHERE tenant_id=$1 AND agent_profile_id=$2 ORDER BY collection_id", [tenantId, agentId])).rows.map(row => row.collection_id).sort();

    const missingCsrf = await patch({ collectionIds: [firstId] }, { cookie: headers.cookie });
    assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);
    assert.deepEqual(await linkedIds(), []);

    const assigned = await patch({ collectionIds: [firstId, secondId] });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.deepEqual(await linkedIds(), [firstId, secondId].sort());
    const detail = await app.inject({ method: "GET", url: route, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.deepEqual(detail.json().collections.map(link => link.collection_id).sort(), [firstId, secondId].sort());
    const list = await app.inject({ method: "GET", url: `/v1/tenants/${tenantId}/agents`, headers });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().agents.find(agent => agent.id === agentId).collection_count, 2);

    const repeated = await patch({ collectionIds: [secondId, firstId] });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.deepEqual(await linkedIds(), [firstId, secondId].sort());
    const profileOnly = await patch({ name: "Renamed catalog agent" });
    assert.equal(profileOnly.statusCode, 200, profileOnly.body);
    assert.deepEqual(await linkedIds(), [firstId, secondId].sort());

    for (const invalidId of [otherBusinessCollectionId, otherTenantCollectionId, archivedId, randomUUID()]) {
      const invalid = await patch({ name: "Must roll back", collectionIds: [secondId, invalidId] });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(invalid.json().error?.code, "COLLECTION_SCOPE_INVALID");
      assert.deepEqual(await linkedIds(), [firstId, secondId].sort());
      const current = await query("SELECT name FROM agent_profiles WHERE id=$1", [agentId]);
      assert.equal(current.rows[0].name, "Renamed catalog agent");
    }

    const replaced = await patch({ collectionIds: [secondId] });
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.deepEqual(await linkedIds(), [secondId]);
    const channelId = (await query(`INSERT INTO channel_accounts(tenant_id,business_id,platform,name,external_account_id,default_agent_profile_id)
      VALUES($1,$2,'facebook','Test Page',$3,$4) RETURNING id`, [tenantId, businessId, `agent-links-page-${suffix}`, agentId])).rows[0].id;
    const trainingId = (await query(`INSERT INTO training_sessions(tenant_id,business_id,agent_profile_id,channel_account_id,status)
      VALUES($1,$2,$3,$4,'open') RETURNING id`, [tenantId, businessId, agentId, channelId])).rows[0].id;
    const duringTraining = await patch({ collectionIds: [] });
    assert.equal(duringTraining.statusCode, 409, duringTraining.body);
    assert.equal(duringTraining.json().error?.code, "CHANNEL_TRAINING_ON");
    assert.deepEqual(await linkedIds(), [secondId]);
    const renameDuringTraining = await patch({ name: "Renamed during training" });
    assert.equal(renameDuringTraining.statusCode, 200, renameDuringTraining.body);
    await query("UPDATE training_sessions SET status='closed',stopped_at=now() WHERE id=$1", [trainingId]);
    const cleared = await patch({ collectionIds: [] });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(await linkedIds(), []);
  } finally {
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (otherTenantId) await query("DELETE FROM tenants WHERE id=$1", [otherTenantId]);
    if (userId) await query("DELETE FROM users WHERE id=$1", [userId]);
    await closeDb();
  }
});
