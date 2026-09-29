import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

process.env.DATABASE_URL ||= "postgresql://unused:unused@127.0.0.1:5432/unused";
process.env.REDIS_URL ||= "redis://127.0.0.1:6379/0";
process.env.APP_ENCRYPTION_KEY ||= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.INTERNAL_SERVICE_AUTH_SECRET ||= "test-internal-service-secret-123456";

const { closeDb, query } = await import("@n8n-automation/core");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function startApi(port, webhookUrl) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      LOG_LEVEL: "error",
      RESEND_API_KEY: "",
      EMAIL_DELIVERY_WEBHOOK_URL: webhookUrl,
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Password-reset test API exited before readiness.");
    try {
      const response = await fetch(`${base}/readyz`);
      if (response.ok) return { child, base };
    } catch { /* Keep waiting while the API starts. */ }
    await sleep(150);
  }
  await stopApi(child);
  throw new Error("Password-reset test API did not become ready.");
}

async function stopApi(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function post(base, path, body, { cookie, csrfToken } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return {
    status: response.status,
    data: await response.json(),
    cookie: cookies.map((value) => String(value).split(";")[0]).join("; "),
  };
}

async function resetTokenCount(email) {
  const result = await query(`
    SELECT count(*)::int AS count
      FROM password_reset_tokens prt
      JOIN auth_credentials c ON c.user_id=prt.user_id AND c.realm=prt.auth_realm
     WHERE c.email=$1 AND c.realm='customer'
  `, [email]);
  return result.rows[0].count;
}

async function verificationTokenCount(email) {
  const result = await query(`
    SELECT count(*)::int AS count
      FROM email_verification_tokens evt
      JOIN users u ON u.id=evt.user_id
     WHERE u.email=$1
  `, [email]);
  return result.rows[0].count;
}

async function accountCount(email) {
  const result = await query("SELECT count(*)::int AS count FROM users WHERE email=$1", [email]);
  return result.rows[0].count;
}

async function invitations(tenantId, email) {
  const result = await query(
    "SELECT id,status FROM tenant_invitations WHERE tenant_id=$1 AND email=$2 ORDER BY created_at",
    [tenantId, email],
  );
  return result.rows;
}

test("production email flows fail closed before mutation and password reset keeps unknown accounts opaque", async (t) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const knownEmail = `reset-known-${suffix}@example.com`;
  const unknownEmail = `reset-unknown-${suffix}@example.com`;
  const blockedSignupEmail = `signup-blocked-${suffix}@example.com`;
  const inviteEmail = `invite-${suffix}@example.com`;
  const password = "StrongPass1234";
  let api;
  let webhook;
  t.after(async () => {
    await stopApi(api?.child);
    if (webhook) await new Promise((resolve) => webhook.close(resolve));
    await closeDb();
  });

  let deliveries = 0;
  webhook = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the local test payload. */ }
    if (request.method !== "POST" || request.url !== "/send") {
      response.writeHead(404).end();
      return;
    }
    deliveries += 1;
    response.writeHead(204).end();
  });
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  const webhookUrl = `http://127.0.0.1:${webhook.address().port}/send`;
  api = await startApi(await availablePort(), webhookUrl);
  const signup = await post(api.base, "/v1/auth/signup", {
    email: knownEmail, password, name: "Reset Test", organizationName: `Reset Test ${suffix}`,
  });
  assert.equal(signup.status, 201);
  assert.ok(signup.cookie && signup.data.csrfToken && signup.data.tenantId);
  const tenantId = signup.data.tenantId;
  assert.equal(deliveries, 1);

  const invite = await post(api.base, `/v1/tenants/${tenantId}/invitations`, {
    email: inviteEmail, role: "STAFF", businessScope: null,
  }, { cookie: signup.cookie, csrfToken: signup.data.csrfToken });
  assert.equal(invite.status, 201);
  const existingInvitations = await invitations(tenantId, inviteEmail);
  assert.equal(existingInvitations.length, 1);
  assert.equal(existingInvitations[0].status, "pending");
  assert.equal(deliveries, 2);

  await stopApi(api.child);
  api = await startApi(await availablePort(), "");
  const unavailableSignup = await post(api.base, "/v1/auth/signup", {
    email: blockedSignupEmail, password, name: "Blocked Signup", organizationName: `Blocked Signup ${suffix}`,
  });
  assert.equal(unavailableSignup.status, 503);
  assert.equal(unavailableSignup.data.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.equal(await accountCount(blockedSignupEmail), 0, "unavailable delivery must not create a user");

  const verificationTokensBefore = await verificationTokenCount(knownEmail);
  const unavailableResend = await post(api.base, "/v1/auth/resend-verification", {}, {
    cookie: signup.cookie, csrfToken: signup.data.csrfToken,
  });
  assert.equal(unavailableResend.status, 503);
  assert.equal(unavailableResend.data.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.equal(await verificationTokenCount(knownEmail), verificationTokensBefore, "unavailable delivery must not create a verification token");

  const unavailableInvite = await post(api.base, `/v1/tenants/${tenantId}/invitations`, {
    email: inviteEmail, role: "VIEWER", businessScope: null,
  }, { cookie: signup.cookie, csrfToken: signup.data.csrfToken });
  assert.equal(unavailableInvite.status, 503);
  assert.equal(unavailableInvite.data.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
  assert.deepEqual(await invitations(tenantId, inviteEmail), existingInvitations, "unavailable delivery must preserve the pending invitation");

  assert.equal(await resetTokenCount(knownEmail), 0);

  const unavailableKnown = await post(api.base, "/v1/auth/request-password-reset", { email: knownEmail });
  const unavailableUnknown = await post(api.base, "/v1/auth/request-password-reset", { email: unknownEmail });
  for (const result of [unavailableKnown, unavailableUnknown]) {
    assert.equal(result.status, 503);
    assert.equal(result.data.error.code, "PASSWORD_RESET_UNAVAILABLE");
  }
  assert.equal(unavailableKnown.data.error.message, unavailableUnknown.data.error.message);
  assert.equal(await resetTokenCount(knownEmail), 0, "unavailable delivery must not create a reset token");
  await stopApi(api.child);
  api = undefined;

  api = await startApi(await availablePort(), webhookUrl);

  const deliveriesBeforeReset = deliveries;
  const unknown = await post(api.base, "/v1/auth/request-password-reset", { email: unknownEmail });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.data, { ok: true });
  assert.equal(deliveries, deliveriesBeforeReset, "unknown accounts must not trigger delivery");

  const known = await post(api.base, "/v1/auth/request-password-reset", { email: knownEmail });
  assert.equal(known.status, 200);
  assert.deepEqual(known.data, { ok: true });
  assert.equal(deliveries, deliveriesBeforeReset + 1, "known accounts must deliver through the configured test webhook");
  assert.equal(await resetTokenCount(knownEmail), 1);
});
