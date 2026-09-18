import type { AppConfig } from "@n8nauto/config";

export async function checkMediaStorage(config: AppConfig, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.media.baseUrl}/api/v1/storage`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.media.apiKey}`,
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Media Storage returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
