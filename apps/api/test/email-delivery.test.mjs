import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379/0";
process.env.APP_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INTERNAL_SERVICE_AUTH_SECRET ||= "test-internal-service-secret-123456";

const { sendEmail } = await import("../src/lib.ts");
const { resetEnvForTests } = await import("@n8n-automation/core");

function configureEmail(overrides = {}) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    RESEND_API_KEY: "",
    RESEND_API_URL: "https://api.resend.com",
    EMAIL_DELIVERY_WEBHOOK_URL: "",
    EMAIL_FROM: "Automation SaaS <no-reply@example.com>",
    ...overrides,
  });
  resetEnvForTests();
}

test("sendEmail uses Resend when an API key is configured", async () => {
  configureEmail({ RESEND_API_KEY: "re_test_key", RESEND_API_URL: "https://resend.test/" });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ id: "email-test-id" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await sendEmail("recipient@example.com", "Welcome", "Verify your account.");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.input, "https://resend.test/emails");
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer re_test_key");
  assert.deepEqual(JSON.parse(request.init.body), {
    from: "Automation SaaS <no-reply@example.com>",
    to: ["recipient@example.com"],
    subject: "Welcome",
    text: "Verify your account.",
  });
});

test("sendEmail keeps the legacy webhook as a fallback", async () => {
  configureEmail({ EMAIL_DELIVERY_WEBHOOK_URL: "https://mail-gateway.test/send" });
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response(null, { status: 204 });
  };

  try {
    await sendEmail("recipient@example.com", "Invitation", "Accept the invitation.");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.input, "https://mail-gateway.test/send");
  assert.deepEqual(JSON.parse(request.init.body), {
    from: "Automation SaaS <no-reply@example.com>",
    to: "recipient@example.com",
    subject: "Invitation",
    text: "Accept the invitation.",
  });
});
