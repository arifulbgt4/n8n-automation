import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cappedCustomerMediaLimit,
  chooseMediaApiKey,
  CUSTOMER_MEDIA_STORAGE_BYTES,
} from "../dist/media.js";

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
