import test from "node:test";
import assert from "node:assert/strict";
import { generateTotpSecret, otpAuthUri, verifyTotp } from "../src/mfa.ts";

test("verifies the RFC 6238 SHA-1 test vector", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(verifyTotp(secret, "287082", 59_000, 0), true);
  assert.equal(verifyTotp(secret, "287083", 59_000, 0), false);
});

test("generates an authenticator-compatible enrollment URI", () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const uri = otpAuthUri("admin@example.com", "n8n Automation SaaS", secret);
  assert.match(uri, /^otpauth:\/\/totp\/n8n%20Automation%20SaaS%3Aadmin%40example\.com\?/);
  assert.match(uri, new RegExp(`secret=${secret}`));
  assert.match(uri, /issuer=n8n\+Automation\+SaaS/);
});
