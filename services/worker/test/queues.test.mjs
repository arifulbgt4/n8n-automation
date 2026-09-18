import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("worker declares the planned queue families", () => {
  const source = fs.readFileSync(new URL("../src/queues.ts", import.meta.url), "utf8");
  for (const name of [
    "inbound",
    "outbound",
    "media",
    "training",
    "embedding",
    "followup",
    "analytics",
    "maintenance"
  ]) {
    assert.match(source, new RegExp(`"${name}"`));
  }
});
