#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const customerUrl = new URL(process.env.CUSTOMER_PANEL_URL || "https://app.openmusk.store");
const adminUrl = new URL(process.env.ADMIN_PANEL_URL || "https://saas-admin.openmusk.store");

function signinUrl(panelUrl) {
  if (!['http:', 'https:'].includes(panelUrl.protocol)) throw new Error("Panel URL must use HTTP or HTTPS");
  return new URL("/api/v1/auth/signin", panelUrl);
}

async function request(url, options) {
  return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(15_000) });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkPreflight(name, panelUrl) {
  const origin = panelUrl.origin;
  const response = await request(signinUrl(panelUrl), {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });
  assert(response.ok, `${name} auth preflight returned HTTP ${response.status}`);
  assert(response.headers.get("access-control-allow-origin") === origin, `${name} auth preflight did not allow ${origin}`);
  assert(response.headers.get("access-control-allow-credentials") === "true", `${name} auth preflight did not allow credentials`);
  assert((response.headers.get("access-control-allow-methods") || "").toUpperCase().split(/\s*,\s*/).includes("POST"), `${name} auth preflight did not allow POST`);
  assert((response.headers.get("access-control-allow-headers") || "").toLowerCase().split(/\s*,\s*/).includes("content-type"), `${name} auth preflight did not allow content-type`);
  console.info(`${name} auth preflight: OK`);
}

async function checkInvalidCustomerSignin(panelUrl) {
  const origin = panelUrl.origin;
  const response = await request(signinUrl(panelUrl), {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: `auth-smoke-${randomUUID()}@example.invalid`,
      password: "synthetic-invalid-password",
      realm: "customer",
    }),
  });
  const result = await response.json().catch(() => ({}));
  assert(response.status === 401 && result?.error?.code === "INVALID_CREDENTIALS", `Customer invalid sign-in returned HTTP ${response.status}, code ${result?.error?.code || "none"}`);
  assert(response.headers.get("access-control-allow-origin") === origin, "Customer sign-in response did not allow the panel origin");
  console.info("Customer invalid sign-in reached authentication: OK (401 INVALID_CREDENTIALS)");
}

try {
  await checkPreflight("Customer", customerUrl);
  await checkPreflight("Admin", adminUrl);
  await checkInvalidCustomerSignin(customerUrl);
} catch (error) {
  console.error(`Public auth smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
