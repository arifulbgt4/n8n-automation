import { decryptSecret } from "@n8n-automation/core";

export type AiConnection = {
  provider: "openai" | "anthropic" | "gemini" | "openai_compatible";
  encrypted_api_key: string | null;
  base_url: string | null;
};

export type AiModelConfig = {
  model: string;
  parameters: Record<string, unknown>;
};

export type ChatInput = {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseSchema?: Record<string, unknown>;
};

export type ChatResult = {
  text: string;
  raw: unknown;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
};

function apiKey(connection: AiConnection): string {
  if (!connection.encrypted_api_key) throw new Error("AI provider API key is missing");
  return decryptSecret(connection.encrypted_api_key);
}

async function jsonResponse(response: Response): Promise<any> {
  const body = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) {
    const message = body?.error?.message || body?.message || body?.text || `AI provider returned ${response.status}`;
    const error = new Error(String(message));
    (error as any).status = response.status;
    (error as any).body = body;
    throw error;
  }
  return body;
}

export async function chat(connection: AiConnection, config: AiModelConfig, input: ChatInput): Promise<ChatResult> {
  if (connection.provider === "openai" || connection.provider === "openai_compatible") {
    const base = (connection.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const messages = [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      ...input.messages,
    ];
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.3,
      max_tokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : undefined,
    };
    if (input.responseSchema && connection.provider === "openai") {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: input.responseSchema },
      };
    }
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(connection)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await jsonResponse(response);
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      raw: json,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
    };
  }

  if (connection.provider === "anthropic") {
    const body = {
      model: config.model,
      max_tokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : 1200,
      temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.3,
      system: input.system,
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey(connection),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await jsonResponse(response);
    const text = Array.isArray(json.content) ? json.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
    return {
      text,
      raw: json,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
    };
  }

  if (connection.provider === "gemini") {
    const model = encodeURIComponent(config.model);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey(connection))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: input.system ? { parts: [{ text: input.system }] } : undefined,
        contents: input.messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })),
        generationConfig: {
          temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.3,
          maxOutputTokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : undefined,
          responseMimeType: input.responseSchema ? "application/json" : undefined,
          responseSchema: input.responseSchema,
        },
      }),
    });
    const json = await jsonResponse(response);
    const text = json.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
    return {
      text,
      raw: json,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
        totalTokens: json.usageMetadata?.totalTokenCount,
      },
    };
  }

  throw new Error(`Unsupported AI provider: ${(connection as any).provider}`);
}

export async function embedding(connection: AiConnection, config: AiModelConfig, text: string): Promise<{ vector: number[]; usage: { inputTokens?: number } }> {
  if (connection.provider === "openai" || connection.provider === "openai_compatible") {
    const base = (connection.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const response = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(connection)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
    });
    const json = await jsonResponse(response);
    return { vector: json.data?.[0]?.embedding ?? [], usage: { inputTokens: json.usage?.prompt_tokens } };
  }
  if (connection.provider === "gemini") {
    const model = encodeURIComponent(config.model);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${encodeURIComponent(apiKey(connection))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `models/${config.model}`, content: { parts: [{ text }] } }),
    });
    const json = await jsonResponse(response);
    return { vector: json.embedding?.values ?? [], usage: {} };
  }
  throw new Error(`Embeddings are not implemented for provider ${connection.provider}`);
}

export async function testConnection(connection: AiConnection, config?: AiModelConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    if (config) {
      await chat(connection, config, { messages: [{ role: "user", content: "Reply with OK only." }] });
      return { ok: true, detail: "Model request succeeded." };
    }
    const key = apiKey(connection);
    return { ok: key.length > 5, detail: "Credential is structurally available; select a model to run an API test." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "AI connection test failed." };
  }
}


export type BinaryAiInput = {
  bytes: Uint8Array;
  mimeType: string;
  filename?: string;
};

export async function analyzeImages(
  connection: AiConnection,
  config: AiModelConfig,
  prompt: string,
  images: BinaryAiInput[],
): Promise<ChatResult> {
  if (!images.length) throw new Error("At least one image is required");

  if (connection.provider === "openai" || connection.provider === "openai_compatible") {
    const base = (connection.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const content: any[] = [{ type: "text", text: prompt }];
    for (const image of images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` },
      });
    }
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(connection)}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content }],
        temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.1,
        max_tokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : 1000,
      }),
    });
    const json = await jsonResponse(response);
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      raw: json,
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
    };
  }

  if (connection.provider === "anthropic") {
    const content: any[] = [{ type: "text", text: prompt }];
    for (const image of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: Buffer.from(image.bytes).toString("base64") },
      });
    }
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey(connection),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : 1000,
        temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.1,
        messages: [{ role: "user", content }],
      }),
    });
    const json = await jsonResponse(response);
    const text = Array.isArray(json.content) ? json.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : "";
    return {
      text,
      raw: json,
      usage: {
        inputTokens: json.usage?.input_tokens,
        outputTokens: json.usage?.output_tokens,
        totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      },
    };
  }

  if (connection.provider === "gemini") {
    const model = encodeURIComponent(config.model);
    const parts: any[] = [{ text: prompt }];
    for (const image of images) {
      parts.push({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.bytes).toString("base64") } });
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey(connection))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: typeof config.parameters.temperature === "number" ? config.parameters.temperature : 0.1,
          maxOutputTokens: typeof config.parameters.maxOutputTokens === "number" ? config.parameters.maxOutputTokens : 1000,
        },
      }),
    });
    const json = await jsonResponse(response);
    const text = json.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
    return {
      text,
      raw: json,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
        totalTokens: json.usageMetadata?.totalTokenCount,
      },
    };
  }

  throw new Error(`Image analysis is not implemented for provider ${(connection as any).provider}`);
}

export async function transcribeAudio(
  connection: AiConnection,
  config: AiModelConfig,
  audio: BinaryAiInput,
): Promise<ChatResult> {
  if (connection.provider === "openai" || connection.provider === "openai_compatible") {
    const base = (connection.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const form = new FormData();
    form.set("model", config.model);
    form.set("file", new Blob([audio.bytes], { type: audio.mimeType }), audio.filename || "audio.bin");
    if (typeof config.parameters.language === "string") form.set("language", config.parameters.language);
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(connection)}` },
      body: form,
    });
    const json = await jsonResponse(response);
    return { text: json.text ?? "", raw: json, usage: json.usage ?? {} };
  }

  if (connection.provider === "gemini") {
    const model = encodeURIComponent(config.model);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey(connection))}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { text: "Transcribe this audio accurately. Return only the transcript." },
            { inlineData: { mimeType: audio.mimeType, data: Buffer.from(audio.bytes).toString("base64") } },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    });
    const json = await jsonResponse(response);
    const text = json.candidates?.[0]?.content?.parts?.map((part: any) => part.text ?? "").join("") ?? "";
    return {
      text,
      raw: json,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount,
        outputTokens: json.usageMetadata?.candidatesTokenCount,
        totalTokens: json.usageMetadata?.totalTokenCount,
      },
    };
  }

  throw new Error(`Audio transcription is not implemented for provider ${connection.provider}`);
}
