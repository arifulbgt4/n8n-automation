import test from "node:test";
import assert from "node:assert/strict";

const { isSerializedAssistantEnvelope, parseAssistantTurn, protectAiOutboundMessages } = await import("../src/assistant-turn-output.ts");

test("parses a fenced JSON order turn with surrounding model commentary without exposing its envelope", () => {
  const modelResponse = JSON.stringify({
    messages: [{ type: "text", text: "আপনার অর্ডারটি গ্রহণ করা হয়েছে।" }],
    actions: [{ tool: "create_order", arguments: { customer: { name: "QA Person", phone: "PRIVATE-TEST-PHONE" } } }],
    handoff: false,
    handoffReason: null,
  });
  const result = parseAssistantTurn(`Here is the response:\n\`\`\`json\n${modelResponse}\n\`\`\`\n`, "অর্ডার কনফার্ম");

  assert.deepEqual(result.messages, [{ type: "text", text: "আপনার অর্ডারটি গ্রহণ করা হয়েছে।" }]);
  assert.equal(result.actions[0].tool, "create_order");
  assert.equal(JSON.stringify(result.messages).includes("PRIVATE-TEST-PHONE"), false);
  assert.equal(JSON.stringify(result.messages).includes('"actions"'), false);
});

test("malformed structured output becomes a safe Bengali reply and cannot execute a partial order", () => {
  const malformed = '{"messages":[{"type":"text","text":"অর্ডারটি নিশ্চিত হয়েছে"}],"actions":[{"tool":"create_order","arguments":{"phone":"PRIVATE-TEST-PHONE"}}]';
  const result = parseAssistantTurn(malformed, "আপনার অর্ডারটি নিশ্চিত করুন");

  assert.equal(result.actions.length, 0);
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].text, /^দুঃখিত,/);
  assert.equal(result.messages[0].text.includes("PRIVATE-TEST-PHONE"), false);
  assert.equal(result.messages[0].text.includes('{"messages"'), false);
});

test("outbound guard replaces an internal JSON envelope, while preserving human-authored messages", () => {
  const envelope = '{"messages":[{"type":"text","text":"অর্ডার নেওয়া হয়েছে"}],"actions":[{"tool":"create_order","arguments":{"phone":"PRIVATE-TEST-PHONE"}}]}';
  assert.equal(isSerializedAssistantEnvelope(envelope), true);

  const guarded = protectAiOutboundMessages([{ type: "text", text: envelope }], "AI");
  assert.equal(guarded.length, 1);
  assert.match(guarded[0].text, /^দুঃখিত,/);
  assert.equal(guarded[0].text.includes("PRIVATE-TEST-PHONE"), false);
  assert.deepEqual(protectAiOutboundMessages([{ type: "text", text: envelope }], "HUMAN"), [{ type: "text", text: envelope }]);
});

test("plain text responses remain customer-visible and unknown action tools are discarded", () => {
  const response = parseAssistantTurn(JSON.stringify({
    messages: [{ type: "text", text: "Your request is being reviewed." }],
    actions: [{ tool: "delete_database", arguments: {} }],
  }));
  assert.deepEqual(response.messages, [{ type: "text", text: "Your request is being reviewed." }]);
  assert.deepEqual(response.actions, []);

  const plainText = parseAssistantTurn("I can help with that.");
  assert.deepEqual(plainText.messages, [{ type: "text", text: "I can help with that." }]);
});
