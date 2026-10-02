import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, encryptSecret, query, sha256 } from "@n8n-automation/core";
import { platformAiCustomerGuard } from "../src/routes/platform-ai-customer-guard.ts";
import { aiRoutes } from "../src/routes/ai.ts";
import { ApiError, jsonError } from "../src/lib.ts";

// Fastify decodes dynamic path parameters before running handlers. Encode every
// UUID character so the regression also covers mixed and fully encoded IDs.
const encodedUuid = id => Array.from(id, character => `%${character.charCodeAt(0).toString(16)}`).join("");

test("encoded tenant and agent UUIDs cannot bypass platform management or daily credit enforcement", {
  skip: !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("unused:unused"),
}, async () => {
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  const suffix = randomUUID();
  let tenantId;
  let userId;
  let platformProviderId;
  let providerCalls = 0;
  try {
    globalThis.fetch = async () => {
      providerCalls++;
      throw new Error("A denied customer route must not invoke an AI provider.");
    };
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      if (error.name === "ZodError") return reply.code(400).send(jsonError(new ApiError(400, "VALIDATION_ERROR", "Request validation failed.", error.issues), request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await platformAiCustomerGuard(app);
    await aiRoutes(app);
    await app.ready();

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`customer-guard-${suffix}@example.test`])).rows[0].id;
    tenantId = (await query("INSERT INTO tenants(name,slug) VALUES('Customer guard test',$1) RETURNING id", [`customer-guard-${suffix}`])).rows[0].id;
    await query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [tenantId, userId]);
    await query("INSERT INTO tenant_limit_overrides(tenant_id,key,value) VALUES($1,'dailyAiCredits',0)", [tenantId]);
    const businessId = (await query("INSERT INTO businesses(tenant_id,name,slug) VALUES($1,'Guard business','main') RETURNING id", [tenantId])).rows[0].id;
    const agentId = (await query("INSERT INTO agent_profiles(tenant_id,business_id,name) VALUES($1,$2,'Guard agent') RETURNING id", [tenantId, businessId])).rows[0].id;
    const promptId = (await query("INSERT INTO prompt_versions(tenant_id,agent_profile_id,version,status,assembled_prompt) VALUES($1,$2,1,'active','Test prompt') RETURNING id", [tenantId, agentId])).rows[0].id;
    await query("UPDATE agent_profiles SET active_prompt_version_id=$2 WHERE id=$1", [agentId, promptId]);
    const providerId = (await query("INSERT INTO ai_provider_connections(tenant_id,business_id,name,provider,encrypted_api_key) VALUES($1,$2,'Legacy provider','openai',$3) RETURNING id", [tenantId, businessId, encryptSecret("unused-test-provider-key")])).rows[0].id;
    await query("INSERT INTO ai_model_configs(tenant_id,business_id,agent_profile_id,provider_connection_id,task_key,model) VALUES($1,$2,$3,$4,'DEFAULT_CHAT','legacy-test-model')", [tenantId, businessId, agentId, providerId]);
    const sessionToken = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,token_hash,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [userId, sha256(sessionToken), sha256(csrf)]);
    const headers = { cookie: `n8nauto_session=${sessionToken}`, "x-csrf-token": csrf, "content-type": "application/json" };
    const request = (method, url, body, requestHeaders = headers) => app.inject({ method, url, headers: requestHeaders, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });

    for (const tenantPath of [tenantId, encodedUuid(tenantId)]) {
      for (const kind of ["providers", "models"]) {
        const url = `/v1/tenants/${tenantPath}/ai/${kind}?guard=test`;
        const anonymous = await request("GET", url, undefined, {});
        assert.equal(anonymous.statusCode, 401, anonymous.body);
        const list = await request("GET", url);
        assert.equal(list.statusCode, 200, list.body);
        assert.deepEqual(list.json(), { [kind]: [] }, "legacy tenant provider/model fixtures must remain hidden");
      }
      const deniedWrites = [
        ["POST", `/v1/tenants/${tenantPath}/ai/providers`, { name: "New provider", provider: "openai", apiKey: "unused-new-provider-key", businessId }],
        ["PATCH", `/v1/tenants/${tenantPath}/ai/providers/${encodedUuid(providerId)}`, { name: "Must remain unchanged" }],
        ["POST", `/v1/tenants/${tenantPath}/ai/providers/${encodedUuid(providerId)}/test`, { model: "legacy-test-model" }],
        ["POST", `/v1/tenants/${tenantPath}/ai/models`, { businessId, providerConnectionId: providerId, taskKey: "DEFAULT_CHAT", model: "must-not-create" }],
      ];
      for (const [method, url, body] of deniedWrites) {
        const denied = await request(method, url, body);
        assert.equal(denied.statusCode, 403, denied.body);
        assert.equal(denied.json().error.code, "PLATFORM_AI_MANAGED");
      }
    }

    for (const [tenantPath, agentPath] of [[tenantId, agentId], [encodedUuid(tenantId), agentId], [tenantId, encodedUuid(agentId)], [encodedUuid(tenantId), encodedUuid(agentId)]]) {
      const url = `/v1/tenants/${tenantPath}/agents/${agentPath}/test?guard=test`;
      const denied = await request("POST", url, { message: "Test daily allowance" });
      assert.equal(denied.statusCode, 402, denied.body);
      assert.equal(denied.json().error.code, "AI_DAILY_CREDIT_LIMIT_REACHED");
      assert.equal(denied.json().error.details.creditLimit, 0);
    }
    const encodedTestUrl = `/v1/tenants/${encodedUuid(tenantId)}/agents/${encodedUuid(agentId)}/test`;
    const anonymousTest = await request("POST", encodedTestUrl, { message: "Denied before provider" }, { "content-type": "application/json" });
    assert.equal(anonymousTest.statusCode, 401, anonymousTest.body);
    const csrfMissing = await request("POST", encodedTestUrl, { message: "Denied before quota" }, { cookie: headers.cookie, "content-type": "application/json" });
    assert.equal(csrfMissing.statusCode, 403, csrfMissing.body);
    assert.equal(csrfMissing.json().error.code, "CSRF_INVALID");
    const foreignTenant = await request("GET", `/v1/tenants/${encodedUuid(randomUUID())}/ai/providers`);
    assert.equal(foreignTenant.statusCode, 404, foreignTenant.body);
    const invalidTenant = await request("GET", "/v1/tenants/%6eot-a-uuid/ai/providers");
    assert.equal(invalidTenant.statusCode, 400, invalidTenant.body);
    assert.equal(invalidTenant.json().error.code, "VALIDATION_ERROR");

    assert.equal(providerCalls, 0);
    assert.equal((await query("SELECT id FROM usage_events WHERE tenant_id=$1", [tenantId])).rows.length, 0);
    assert.equal((await query("SELECT name FROM ai_provider_connections WHERE tenant_id=$1", [tenantId])).rows[0].name, "Legacy provider");
    assert.equal((await query("SELECT id FROM ai_provider_connections WHERE tenant_id=$1", [tenantId])).rows.length, 1);
    assert.equal((await query("SELECT id FROM ai_model_configs WHERE tenant_id=$1", [tenantId])).rows.length, 1);

    // An allowed encoded request must still use the managed platform model.
    // Mock its HTTP response locally; no real provider request is sent.
    platformProviderId = (await query("INSERT INTO platform_ai_provider_connections(name,provider,encrypted_api_key) VALUES($1,'openai',$2) RETURNING id", [`Guard platform provider ${suffix}`, encryptSecret("unused-platform-test-key")])).rows[0].id;
    const platformModel = `guard-platform-model-${suffix}`;
    const platformRouteId = (await query("INSERT INTO platform_ai_model_routes(provider_connection_id,task_key,model,priority) VALUES($1,'DEFAULT_CHAT',$2,0) RETURNING id", [platformProviderId, platformModel])).rows[0].id;
    await query("UPDATE tenant_limit_overrides SET value=10 WHERE tenant_id=$1 AND key='dailyAiCredits'", [tenantId]);
    globalThis.fetch = async (url, init) => {
      providerCalls++;
      assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
      assert.equal(JSON.parse(init.body).model, platformModel);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Managed test response" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const successful = await request("POST", encodedTestUrl, { message: "Allowed managed test" });
    assert.equal(successful.statusCode, 200, successful.body);
    assert.deepEqual(successful.json(), { response: "Managed test response", promptVersionId: promptId, platformManagedAi: true });
    const recorded = (await query("SELECT input_tokens,output_tokens,total_tokens,credits,metadata FROM usage_events WHERE tenant_id=$1", [tenantId])).rows;
    assert.equal(recorded.length, 1);
    assert.equal(Number(recorded[0].input_tokens), 12);
    assert.equal(Number(recorded[0].output_tokens), 3);
    assert.equal(Number(recorded[0].total_tokens), 15);
    assert.ok(Number(recorded[0].credits) > 0);
    assert.equal(recorded[0].metadata.platformModelRouteId, platformRouteId);
    assert.equal(providerCalls, 1, "only the locally mocked managed call ran");
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    if (tenantId) await query("DELETE FROM tenants WHERE id=$1", [tenantId]);
    if (platformProviderId) await query("DELETE FROM platform_ai_provider_connections WHERE id=$1", [platformProviderId]);
    if (userId) {
      await query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
      await query("DELETE FROM users WHERE id=$1", [userId]);
    }
    await closeDb();
  }
});
