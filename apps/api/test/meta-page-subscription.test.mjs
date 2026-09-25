import test from "node:test";
import assert from "node:assert/strict";
import { resetEnvForTests } from "@n8n-automation/core";
import {
  ensureMetaPageSubscription,
  META_PAGE_SUBSCRIBED_FIELDS,
} from "../src/meta-page-subscription.ts";

function configureEnv() {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.REDIS_URL = "redis://127.0.0.1:6379/0";
  process.env.APP_ENCRYPTION_KEY = "00".repeat(32);
  process.env.INTERNAL_SERVICE_AUTH_SECRET = "test-internal-service-secret-123456";
  process.env.META_APP_ID = "app-123";
  process.env.META_GRAPH_API_VERSION = "v23.0";
  resetEnvForTests();
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("ensureMetaPageSubscription leaves an already-correct subscription unchanged", async () => {
  configureEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || "GET", body: init.body });
    return response({
      data: [{ id: "app-123", subscribed_fields: [...META_PAGE_SUBSCRIBED_FIELDS] }],
    });
  };

  try {
    const result = await ensureMetaPageSubscription("page-1", "page-token");
    assert.equal(result.ok, true);
    assert.equal(result.subscribed, true);
    assert.equal(result.mutated, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureMetaPageSubscription subscribes and verifies a missing Page subscription", async () => {
  configureEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  let step = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method || "GET", body: init.body });
    step += 1;
    if (step === 1) return response({ data: [] });
    if (step === 2) return response({ success: true });
    return response({
      data: [{ id: "app-123", subscribed_fields: [...META_PAGE_SUBSCRIBED_FIELDS] }],
    });
  };

  try {
    const result = await ensureMetaPageSubscription("page-2", "page-token");
    assert.equal(result.ok, true);
    assert.equal(result.subscribed, true);
    assert.equal(result.mutated, true);
    assert.deepEqual(result.subscribedFields, [...META_PAGE_SUBSCRIBED_FIELDS]);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].method, "POST");
    assert.match(String(calls[1].body), /subscribed_fields=/);
    for (const field of META_PAGE_SUBSCRIBED_FIELDS) {
      assert.match(decodeURIComponent(String(calls[1].body)), new RegExp(field));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ensureMetaPageSubscription surfaces Meta permission failures without leaking the token", async () => {
  configureEnv();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    if ((init.method || "GET") === "GET") return response({ data: [] });
    return response({ error: { message: "Permissions error", type: "OAuthException", code: 200 } }, 403);
  };

  try {
    const result = await ensureMetaPageSubscription("page-3", "super-secret-page-token");
    assert.equal(result.ok, false);
    assert.equal(result.providerError?.code, 200);
    assert.equal(result.detail, "Permissions error");
    assert.equal(JSON.stringify(result).includes("super-secret-page-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
