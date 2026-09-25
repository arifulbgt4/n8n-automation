import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decryptSecret, query } from "@n8n-automation/core";
import { assertSafeAiBaseUrl } from "../ai-provider.js";
import { ApiError, requireTenant } from "../lib.js";

type ProviderRow = {
  id: string;
  tenant_id: string;
  provider: "openai" | "anthropic" | "gemini" | "openai_compatible";
  encrypted_api_key: string | null;
  base_url: string | null;
  status: string;
};

type CatalogModel = {
  id: string;
  label: string;
  ownedBy?: string | null;
  methods?: string[];
};

function keyFor(provider: ProviderRow): string {
  if (!provider.encrypted_api_key) {
    throw new ApiError(409, "AI_PROVIDER_KEY_MISSING", "AI provider API key is missing.");
  }
  return decryptSecret(provider.encrypted_api_key);
}

async function providerJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || body?.text || `Provider returned ${response.status}`;
    throw new ApiError(502, "AI_MODEL_CATALOG_FAILED", String(detail), { providerStatus: response.status });
  }
  return body;
}

async function discoverModels(provider: ProviderRow): Promise<CatalogModel[]> {
  const apiKey = keyFor(provider);

  if (provider.provider === "openai" || provider.provider === "openai_compatible") {
    const base = provider.base_url ? assertSafeAiBaseUrl(provider.base_url) : "https://api.openai.com/v1";
    const body = await providerJson(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    return (Array.isArray(body?.data) ? body.data : [])
      .map((item: any) => ({
        id: String(item?.id || ""),
        label: String(item?.id || ""),
        ownedBy: item?.owned_by ? String(item.owned_by) : null,
      }))
      .filter((item: CatalogModel) => item.id)
      .sort((a: CatalogModel, b: CatalogModel) => a.id.localeCompare(b.id));
  }

  if (provider.provider === "anthropic") {
    const body = await providerJson("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    return (Array.isArray(body?.data) ? body.data : [])
      .map((item: any) => ({
        id: String(item?.id || ""),
        label: String(item?.display_name || item?.id || ""),
      }))
      .filter((item: CatalogModel) => item.id)
      .sort((a: CatalogModel, b: CatalogModel) => a.id.localeCompare(b.id));
  }

  if (provider.provider === "gemini") {
    const body = await providerJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`,
      {},
    );
    return (Array.isArray(body?.models) ? body.models : [])
      .map((item: any) => {
        const rawName = String(item?.name || "");
        const id = rawName.replace(/^models\//, "");
        return {
          id,
          label: String(item?.displayName || id),
          methods: Array.isArray(item?.supportedGenerationMethods)
            ? item.supportedGenerationMethods.map(String)
            : [],
        };
      })
      .filter((item: CatalogModel) => item.id)
      .sort((a: CatalogModel, b: CatalogModel) => a.id.localeCompare(b.id));
  }

  return [];
}

export async function aiModelCatalogRoutes(app: FastifyInstance) {
  app.get("/v1/tenants/:tenantId/ai/providers/:providerId/catalog", async (request, reply) => {
    const params = z.object({ tenantId: z.string().uuid(), providerId: z.string().uuid() }).parse(request.params);
    await requireTenant(request, params.tenantId, ["OWNER", "ADMIN"]);

    const result = await query<ProviderRow>(
      `SELECT id,tenant_id,provider,encrypted_api_key,base_url,status
       FROM ai_provider_connections
       WHERE id=$1 AND tenant_id=$2`,
      [params.providerId, params.tenantId],
    );
    const provider = result.rows[0];
    if (!provider) throw new ApiError(404, "AI_PROVIDER_NOT_FOUND", "AI provider connection not found.");
    if (provider.status === "disabled") throw new ApiError(409, "AI_PROVIDER_DISABLED", "AI provider connection is disabled.");

    const models = await discoverModels(provider);
    reply.send({ providerId: provider.id, provider: provider.provider, models });
  });
}
