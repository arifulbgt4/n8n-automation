import assert from "node:assert/strict";
import test from "node:test";
import { getCsrfToken, setCsrfToken, signOut } from "../lib/api.ts";

function browserContext(t) {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
  };
  globalThis.document = { cookie: "" };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });
}

test("sign out sends the active CSRF token and clears local state after server success", async (t) => {
  browserContext(t);
  setCsrfToken("old-token");
  globalThis.document.cookie = "n8nauto_csrf=current-token";
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/api/v1/auth/signout");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "include");
    assert.equal(init.headers.get("x-csrf-token"), "current-token");
    return Response.json({ ok: true });
  };
  await signOut();
  globalThis.document.cookie = "";
  assert.equal(getCsrfToken(), null);
});

test("sign out accepts a confirmed expired session", async (t) => {
  browserContext(t);
  setCsrfToken("expired-token");
  globalThis.fetch = async () => Response.json(
    { error: { code: "AUTH_REQUIRED", message: "Authentication is required." } },
    { status: 401 },
  );
  await signOut();
  assert.equal(getCsrfToken(), null);
});

test("sign out preserves the CSRF token after a rejected or unavailable request", async (t) => {
  browserContext(t);
  setCsrfToken("retry-token");
  globalThis.fetch = async () => Response.json(
    { error: { code: "CSRF_INVALID", message: "CSRF token is missing or invalid." } },
    { status: 403 },
  );
  await assert.rejects(signOut(), { status: 403, code: "CSRF_INVALID" });
  assert.equal(getCsrfToken(), "retry-token");

  globalThis.fetch = async () => { throw new Error("Connection lost"); };
  await assert.rejects(signOut(), /Connection lost/);
  assert.equal(getCsrfToken(), "retry-token");
});
