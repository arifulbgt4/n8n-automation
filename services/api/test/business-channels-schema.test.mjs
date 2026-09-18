import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("business/channel migration includes tenant-scoped domain and encrypted credentials", () => {
  const migration = fs.readFileSync(
    new URL("../drizzle/0003_business_channels.sql", import.meta.url),
    "utf8"
  );
  for (const table of ["businesses", "channel_accounts", "channel_credentials"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /channel_accounts_platform_external_uidx/);
  assert.match(migration, /ciphertext text NOT NULL/);
  assert.doesNotMatch(migration, /access_token text/i);
});
