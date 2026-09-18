import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("tenancy migration contains isolation and admin tables", () => {
  const migration = fs.readFileSync(
    new URL("../drizzle/0002_tenancy_rbac.sql", import.meta.url),
    "utf8"
  );
  for (const table of [
    "tenants",
    "tenant_memberships",
    "tenant_invitations",
    "business_membership_restrictions",
    "platform_admins"
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /tenant_memberships_tenant_user_uidx/);
});
