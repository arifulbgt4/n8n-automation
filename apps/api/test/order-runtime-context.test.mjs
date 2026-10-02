import test from "node:test";
import assert from "node:assert/strict";
import { orderActionContract } from "../src/action-contracts.ts";
import { findConversationItems } from "../src/catalog-lookup.ts";

test("order-enabled runtime explains the executable order schema and success boundary", () => {
  const prompt = orderActionContract(["ORDER_CREATE", "DATA_SEARCH"]);
  assert.match(prompt, /text-only order confirmation does not create a saved order/);
  assert.match(prompt, /"collectionItemId"/);
  assert.match(prompt, /"quantity":1,"unitPrice":899/);
  assert.match(prompt, /application executes actions before sending the reply/);
  assert.equal(orderActionContract(["DATA_SEARCH"]), "");
});

test("a short customer confirmation refreshes the most recent product using the same scoped catalog lookup", async () => {
  const calls = [];
  const currentItem = { id: "current-item", title: "Tangail suti saree", data_jsonb: { price: 899 } };
  const result = await findConversationItems("tenant", "business", "agent", "channel", "হ্যাঁ কনফার্ম", [
    "I want the older scarf",
    "Tangail suti saree, quantity 1, is the selected product.",
    "Please confirm the delivery details.",
  ], async (sql, values) => {
    assert.match(sql, /agent_collection_links/);
    assert.match(sql, /collection_channel_links/);
    assert.deepEqual(values.slice(0, 4), ["tenant", "business", "agent", "channel"]);
    calls.push(values[6]);
    return { rows: values[6].includes("tangail") ? [currentItem] : [] };
  });
  assert.deepEqual(result, [currentItem]);
  assert.equal(calls.some(words => words.includes("older")), false, "the most recent matching product takes precedence");
});

test("a new explicit product request does not reuse a different earlier product", async () => {
  let count = 0;
  const item = { id: "new-item", title: "Cotton scarf" };
  const result = await findConversationItems("tenant", "business", "agent", "channel", "Cotton scarf", ["Tangail saree"], async () => {
    count++;
    return { rows: [item] };
  });
  assert.deepEqual(result, [item]);
  assert.equal(count, 1);
});

test("conversation fallback never searches beyond eight recent exchanges", async () => {
  const searched = [];
  const result = await findConversationItems("tenant", "business", "agent", "channel", "Confirm", [
    "Old product outside the current exchange", ...Array.from({ length: 8 }, (_, index) => `Recent exchange ${index}`),
  ], async (_sql, values) => { searched.push(values[6]); return { rows: [] }; });
  assert.deepEqual(result, []);
  assert.equal(searched.some(words => words.includes("old")), false);
});
