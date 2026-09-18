import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("auth migration contains Better Auth core tables", () => {
  const migration = fs.readFileSync(
    new URL("../drizzle/0001_auth_core.sql", import.meta.url),
    "utf8"
  );
  for (const table of ["users", "sessions", "accounts", "verifications"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
});
