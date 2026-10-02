import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { closeDb, query, sha256 } from "@n8n-automation/core";
import { platformAiRoutes } from "../src/routes/platform-ai.ts";
import { creditsForUsage, resolvePlatformModels } from "../src/platform-ai.ts";
import { ApiError, jsonError } from "../src/lib.ts";

test("global credit rate rejects values below storage precision and returns the rate every route actually uses", {
  skip: !process.env.DATABASE_URL || process.env.DATABASE_URL.includes("unused:unused"),
}, async () => {
  const app = Fastify();
  const suffix = randomUUID();
  let originalSettings;
  let userId;
  const providerIds = [];
  try {
    await app.register(cookie);
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send(jsonError(error, request));
      if (error.name === "ZodError") return reply.code(400).send(jsonError(new ApiError(400, "VALIDATION_ERROR", "Request validation failed.", error.issues), request));
      reply.code(500).send({ error: { code: "TEST_UNHANDLED", message: error.message } });
    });
    await platformAiRoutes(app);
    await app.ready();
    originalSettings = (await query("SELECT tokens_per_credit,updated_by,updated_at FROM platform_ai_settings WHERE singleton=true")).rows[0];
    assert.ok(originalSettings, "migration 018 must initialize the global settings");

    userId = (await query("INSERT INTO users(email,password_hash) VALUES($1,'test-hash') RETURNING id", [`global-rate-${suffix}@example.test`])).rows[0].id;
    await query("INSERT INTO platform_admins(user_id,role) VALUES($1,'SUPER_ADMIN')", [userId]);
    const sessionToken = randomUUID();
    const csrf = randomUUID();
    await query("INSERT INTO sessions(user_id,auth_realm,token_hash,csrf_token,expires_at) VALUES($1,'admin',$2,$3,now()+interval '1 day')", [userId, sha256(sessionToken), sha256(csrf)]);
    const headers = { cookie: `n8nauto_session=${sessionToken}`, "x-csrf-token": csrf, "content-type": "application/json" };
    const patch = (tokensPerCredit, requestHeaders = headers) => app.inject({ method: "PATCH", url: "/v1/admin/platform-ai/settings", headers: requestHeaders, payload: JSON.stringify({ tokensPerCredit }) });

    const unauthorized = await patch(2000, { "content-type": "application/json" });
    assert.equal(unauthorized.statusCode, 401, unauthorized.body);
    const missingCsrf = await patch(2000, { cookie: headers.cookie, "content-type": "application/json" });
    assert.equal(missingCsrf.statusCode, 403, missingCsrf.body);
    for (const rate of [0, -1, 0.0000001, 0.00000049, 1_000_000_001]) {
      const rejected = await patch(rate);
      assert.equal(rejected.statusCode, 400, rejected.body);
      assert.equal(rejected.json().error.code, "VALIDATION_ERROR");
      const current = (await query("SELECT tokens_per_credit FROM platform_ai_settings WHERE singleton=true")).rows[0];
      assert.equal(Number(current.tokens_per_credit), Number(originalSettings.tokens_per_credit), "invalid requests must not change the global rate");
    }

    const minimum = await patch(0.000001);
    assert.equal(minimum.statusCode, 200, minimum.body);
    assert.equal(minimum.json().tokensPerCredit, 0.000001);
    const rounded = await patch(1234.5678904);
    assert.equal(rounded.statusCode, 200, rounded.body);
    assert.equal(rounded.json().tokensPerCredit, 1234.56789, "the response reflects PostgreSQL's six-decimal persisted value");
    const read = await app.inject({ method: "GET", url: "/v1/admin/platform-ai/settings", headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().tokensPerCredit, rounded.json().tokensPerCredit);

    const routeIds = [];
    for (const [index, provider] of ["openai", "anthropic"].entries()) {
      const providerId = (await query("INSERT INTO platform_ai_provider_connections(name,provider,encrypted_api_key) VALUES($1,$2,'unused-test-key') RETURNING id", [`Rate test ${suffix} ${index}`, provider])).rows[0].id;
      providerIds.push(providerId);
      const route = (await query(`INSERT INTO platform_ai_model_routes(provider_connection_id,task_key,model,priority,input_credits_per_1k_tokens,output_credits_per_1k_tokens,request_credits)
        VALUES($1,'STRUCTURED_EXTRACTION',$2,0,$3,$4,$5) RETURNING id`, [providerId, `rate-model-${suffix}-${index}`, index ? 900 : 0.01, index ? 1200 : 0.02, index ? 50 : 0])).rows[0];
      routeIds.push(route.id);
    }
    const checkRoutes = async (expectedRate) => {
      const models = (await resolvePlatformModels("STRUCTURED_EXTRACTION", 100)).filter(model => routeIds.includes(model.id));
      assert.equal(models.length, 2);
      for (const model of models) {
        assert.equal(Number(model.tokens_per_credit), expectedRate);
        assert.equal(creditsForUsage(model, { totalTokens: expectedRate * 2 }), 2, "provider and legacy route weights must not affect credits");
      }
    };
    await checkRoutes(rounded.json().tokensPerCredit);
    const changed = await patch(2000);
    assert.equal(changed.statusCode, 200, changed.body);
    await checkRoutes(2000);
  } finally {
    await app.close();
    if (originalSettings) await query("UPDATE platform_ai_settings SET tokens_per_credit=$1,updated_by=$2,updated_at=$3 WHERE singleton=true", [originalSettings.tokens_per_credit, originalSettings.updated_by, originalSettings.updated_at]);
    for (const providerId of providerIds) await query("DELETE FROM platform_ai_provider_connections WHERE id=$1", [providerId]);
    if (userId) {
      await query("DELETE FROM audit_logs WHERE actor_user_id=$1", [userId]);
      await query("DELETE FROM users WHERE id=$1", [userId]);
    }
    await closeDb();
  }
});
