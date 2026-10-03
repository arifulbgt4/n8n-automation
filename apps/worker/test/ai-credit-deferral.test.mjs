import test from "node:test";
import assert from "node:assert/strict";
import { aiAllowanceRetryAt } from "../src/ai-credit-deferral.ts";

test("daily allowance errors defer until shortly after the UTC reset", () => {
  const now = Date.parse("2026-10-03T18:00:00.000Z");
  const resetAt = "2026-10-04T00:00:00.000Z";
  const error = { body: { error: { code: "AI_DAILY_CREDIT_LIMIT_REACHED", details: { resetAt } } } };

  assert.equal(aiAllowanceRetryAt(error, now), Date.parse(resetAt) + 30_000);
});

test("unrelated and malformed API failures are not deferred", () => {
  assert.equal(aiAllowanceRetryAt(new Error("network failure"), 100), null);
  assert.equal(aiAllowanceRetryAt({ body: { error: { code: "AI_MODEL_MISSING", details: { resetAt: "2026-10-04T00:00:00Z" } } } }, 100), null);
  assert.equal(aiAllowanceRetryAt({ body: { error: { code: "AI_DAILY_CREDIT_LIMIT_REACHED", details: {} } } }, 100), null);
});
