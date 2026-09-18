import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("foundation migration contains durable operational tables", () => {
  const migration = fs.readFileSync(
    new URL("../drizzle/0000_foundation.sql", import.meta.url),
    "utf8"
  );

  for (const table of ["outbox_events", "audit_events", "automation_deployments"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }

  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS vector/);
});
