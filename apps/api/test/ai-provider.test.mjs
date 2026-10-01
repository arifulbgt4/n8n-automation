import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, resetEnvForTests } from "@n8n-automation/core";
import { analyzeImages } from "../src/ai-provider.ts";

function configureEnv() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test",
    REDIS_URL: "redis://127.0.0.1:6379/0",
    APP_ENCRYPTION_KEY: "00".repeat(32),
    INTERNAL_SERVICE_AUTH_SECRET: "test-internal-service-secret-123456",
  });
  resetEnvForTests();
}

test("OpenAI image analysis sends max_completion_tokens for current vision models", async () => {
  configureEnv();
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init = {}) => {
    request = { input: String(input), init, body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({
      choices: [{ message: { content: "A synthetic test image." } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await analyzeImages({
      provider: "openai",
      encrypted_api_key: encryptSecret("test-provider-key"),
      base_url: null,
    }, {
      model: "gpt-5.6-terra",
      parameters: { maxOutputTokens: 321 },
    }, "Describe the image.", [{
      bytes: Buffer.from("synthetic image bytes"),
      mimeType: "image/png",
    }]);

    assert.equal(request.input, "https://api.openai.com/v1/chat/completions");
    assert.equal(request.body.max_completion_tokens, 321);
    assert.equal("max_tokens" in request.body, false);
    assert.equal(request.body.messages[0].content[1].image_url.url, `data:image/png;base64,${Buffer.from("synthetic image bytes").toString("base64")}`);
    assert.equal(result.text, "A synthetic test image.");
    assert.equal(result.usage.totalTokens, 14);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
