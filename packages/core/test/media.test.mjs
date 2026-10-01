import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cappedCustomerMediaLimit,
  chooseMediaApiKey,
  CUSTOMER_MEDIA_STORAGE_BYTES,
  mediaApiKeyForAsset,
} from "../dist/media.js";
import { resetEnvForTests } from "../dist/env.js";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379/0";
process.env.APP_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INTERNAL_SERVICE_AUTH_SECRET ||= "test-internal-service-secret-123456";

test("every plan and override is capped at 512 MiB", () => {
  assert.equal(cappedCustomerMediaLimit(null), CUSTOMER_MEDIA_STORAGE_BYTES);
  assert.equal(cappedCustomerMediaLimit(2 * CUSTOMER_MEDIA_STORAGE_BYTES), CUSTOMER_MEDIA_STORAGE_BYTES);
  assert.equal(cappedCustomerMediaLimit(128 * 1024 * 1024), 128 * 1024 * 1024);
  assert.equal(cappedCustomerMediaLimit(-1), 0);
});

test("new shared files use the shared app key, old files retain their legacy key", () => {
  const legacy = { userId: "old-account", key: "old-key" };
  assert.equal(chooseMediaApiKey("shared-account", "shared-key", legacy), "shared-key");
  assert.equal(chooseMediaApiKey("old-account", "shared-key", legacy), "old-key");
  assert.equal(chooseMediaApiKey(null, "shared-key", legacy), "old-key");
  assert.throws(() => chooseMediaApiKey("shared-account", null, legacy));
});

test("media key lookup uses an injected transaction client when provided", async () => {
  process.env.MEDIA_API_KEY = "shared-key";
  resetEnvForTests();
  let queryCount = 0;
  const client = {
    async query(sql, values) {
      queryCount += 1;
      assert.match(sql, /tenant_media_accounts/);
      assert.deepEqual(values, ["tenant-1"]);
      return { rows: [] };
    },
  };

  assert.equal(await mediaApiKeyForAsset("tenant-1", "shared-account", client), "shared-key");
  assert.equal(queryCount, 1);
});
