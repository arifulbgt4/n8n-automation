import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeAiBaseUrl } from "../src/ai-provider.ts";
import { safeSecretEqual } from "../src/lib.ts";

test("compares internal secrets without accepting missing or different values", () => {
  assert.equal(safeSecretEqual("shared-secret", "shared-secret"), true);
  assert.equal(safeSecretEqual("shared-secret", "shared-secret-2"), false);
  assert.equal(safeSecretEqual(undefined, "shared-secret"), false);
});

test("rejects private and unsafe AI provider endpoints", async () => {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
  process.env.REDIS_URL = "redis://127.0.0.1:6379/0";
  process.env.APP_ENCRYPTION_KEY = "00".repeat(32);
  process.env.INTERNAL_SERVICE_AUTH_SECRET = "test-internal-service-secret-123456";
  const { resetEnvForTests } = await import("@n8n-automation/core");
  resetEnvForTests();

  await assert.rejects(assertSafeAiBaseUrl("http://127.0.0.1:8080/v1"), /private network/);
  await assert.rejects(assertSafeAiBaseUrl("https://[::1]/v1"), /private network/);
  await assert.rejects(assertSafeAiBaseUrl("https://localhost/v1"), /private hostname/);
  await assert.rejects(assertSafeAiBaseUrl("ftp://example.com/v1"), /HTTPS/);
});
