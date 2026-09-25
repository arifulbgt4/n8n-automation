import assert from "node:assert/strict";
import test from "node:test";
import { creditsForUsage, normalizeAiUsage } from "../src/platform-ai.ts";

const model={
  id:"00000000-0000-4000-8000-000000000001",
  provider_connection_id:"00000000-0000-4000-8000-000000000002",
  provider:"openai",
  encrypted_api_key:"unused",
  base_url:null,
  model:"example-model",
  parameters:{},
  input_credits_per_1k_tokens:0.5,
  output_credits_per_1k_tokens:2,
  request_credits:0.25,
  priority:100,
  ownership_mode:"PLATFORM",
};

test("normalizes common provider token fields",()=>{
  assert.deepEqual(normalizeAiUsage({inputTokens:120,outputTokens:30,totalTokens:150}),{inputTokens:120,outputTokens:30,totalTokens:150});
  assert.deepEqual(normalizeAiUsage({prompt_tokens:200,completion_tokens:50,total_tokens:250}),{inputTokens:200,outputTokens:50,totalTokens:250});
  assert.deepEqual(normalizeAiUsage({promptTokenCount:90,candidatesTokenCount:10,totalTokenCount:100}),{inputTokens:90,outputTokens:10,totalTokens:100});
});

test("falls back to input plus output when total is absent",()=>{
  assert.deepEqual(normalizeAiUsage({input_tokens:70,output_tokens:30}),{inputTokens:70,outputTokens:30,totalTokens:100});
});

test("calculates model-weighted credits",()=>{
  const credits=creditsForUsage(model,{inputTokens:1000,outputTokens:500,totalTokens:1500});
  assert.equal(credits,1.75);
});

test("request credits apply even when a provider reports no tokens",()=>{
  assert.equal(creditsForUsage(model,{}),0.25);
});
