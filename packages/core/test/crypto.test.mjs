import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379/0";
process.env.APP_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INTERNAL_SERVICE_AUTH_SECRET ||= "test-internal-service-secret-123456";

const {
  decryptSecret,
  encryptSecret,
  hashPassword,
  maskSecret,
  randomToken,
  sha256,
  verifyPassword,
} = await import("../dist/index.js");

test("secret encryption round trips without exposing plaintext", () => {
  const plaintext = "secret-value-123";
  const encrypted = encryptSecret(plaintext);
  assert.notEqual(encrypted, plaintext);
  assert.equal(decryptSecret(encrypted), plaintext);
});

test("password hashing verifies correct password only", async () => {
  const encoded = await hashPassword("StrongPassword123");
  assert.equal(await verifyPassword("StrongPassword123", encoded), true);
  assert.equal(await verifyPassword("WrongPassword123", encoded), false);
});

test("helpers produce stable hash, masked values and random tokens", () => {
  assert.equal(sha256("abc").length, 64);
  assert.equal(maskSecret("1234567890"), "1234…7890");
  assert.equal(maskSecret("short"), "********");
  assert.ok(randomToken(16).length >= 20);
});
