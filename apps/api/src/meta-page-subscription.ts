import { env } from "@n8n-automation/core";

export const META_PAGE_SUBSCRIBED_FIELDS = [
  "messages",
  "message_deliveries",
  "message_reads",
  "message_echoes",
] as const;

type ProviderError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
};

export type MetaPageSubscriptionResult = {
  ok: boolean;
  subscribed: boolean;
  pageId: string;
  appId: string | null;
  requestedFields: string[];
  subscribedFields: string[] | null;
  mutated: boolean;
  detail: string;
  httpStatus?: number;
  providerError?: ProviderError | null;
};

function providerError(body: unknown): ProviderError | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { error?: unknown }).error;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  return {
    message: typeof value.message === "string" ? value.message : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
    code: typeof value.code === "number" ? value.code : undefined,
    error_subcode: typeof value.error_subcode === "number" ? value.error_subcode : undefined,
  };
}

function failure(input: {
  pageId: string;
  detail: string;
  httpStatus?: number;
  providerError?: ProviderError | null;
  mutated?: boolean;
}): MetaPageSubscriptionResult {
  return {
    ok: false,
    subscribed: false,
    pageId: input.pageId,
    appId: env().META_APP_ID || null,
    requestedFields: [...META_PAGE_SUBSCRIBED_FIELDS],
    subscribedFields: null,
    mutated: input.mutated ?? false,
    detail: input.detail,
    httpStatus: input.httpStatus,
    providerError: input.providerError ?? null,
  };
}

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

async function fetchSubscribedApps(
  pageId: string,
  pageAccessToken: string,
  includeSubscribedFields: boolean,
): Promise<{ response: Response; body: any }> {
  const url = new URL(
    `https://graph.facebook.com/${env().META_GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );
  if (includeSubscribedFields) url.searchParams.set("fields", "id,name,subscribed_fields");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${pageAccessToken}` },
  });
  return { response, body: await readJson(response) };
}

export async function inspectMetaPageSubscription(
  pageId: string,
  pageAccessToken: string,
): Promise<MetaPageSubscriptionResult> {
  const appId = env().META_APP_ID || null;
  if (!appId) return failure({ pageId, detail: "META_APP_ID is not configured." });

  try {
    let inspection = await fetchSubscribedApps(pageId, pageAccessToken, true);
    if (!inspection.response.ok && inspection.response.status === 400) {
      inspection = await fetchSubscribedApps(pageId, pageAccessToken, false);
    }
    if (!inspection.response.ok) {
      const error = providerError(inspection.body);
      return failure({
        pageId,
        detail: error?.message || `Meta subscription inspection failed with ${inspection.response.status}.`,
        httpStatus: inspection.response.status,
        providerError: error,
      });
    }

    const apps = Array.isArray(inspection.body?.data) ? inspection.body.data : [];
    const app = apps.find((candidate: any) => String(candidate?.id ?? "") === appId);
    if (!app) {
      return {
        ok: true,
        subscribed: false,
        pageId,
        appId,
        requestedFields: [...META_PAGE_SUBSCRIBED_FIELDS],
        subscribedFields: null,
        mutated: false,
        detail: "The Meta app is not subscribed to this Page.",
      };
    }

    const subscribedFields = Array.isArray(app.subscribed_fields)
      ? app.subscribed_fields.map((field: unknown) => String(field))
      : null;
    const missing = subscribedFields
      ? META_PAGE_SUBSCRIBED_FIELDS.filter((field) => !subscribedFields.includes(field))
      : [];

    return {
      ok: true,
      subscribed: true,
      pageId,
      appId,
      requestedFields: [...META_PAGE_SUBSCRIBED_FIELDS],
      subscribedFields,
      mutated: false,
      detail: missing.length
        ? `The Meta app is subscribed, but required webhook fields are missing: ${missing.join(", ")}.`
        : "The Meta app is subscribed to this Page.",
    };
  } catch (error) {
    return failure({
      pageId,
      detail: error instanceof Error ? error.message : "Meta subscription inspection failed.",
    });
  }
}

export async function ensureMetaPageSubscription(
  pageId: string,
  pageAccessToken: string,
): Promise<MetaPageSubscriptionResult> {
  const appId = env().META_APP_ID || null;
  if (!appId) return failure({ pageId, detail: "META_APP_ID is not configured." });

  const before = await inspectMetaPageSubscription(pageId, pageAccessToken);
  if (before.ok && before.subscribed && before.subscribedFields) {
    const missing = META_PAGE_SUBSCRIBED_FIELDS.filter((field) => !before.subscribedFields!.includes(field));
    if (!missing.length) return before;
  }

  const url = new URL(
    `https://graph.facebook.com/${env().META_GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );
  const body = new URLSearchParams({
    subscribed_fields: META_PAGE_SUBSCRIBED_FIELDS.join(","),
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pageAccessToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const payload = await readJson(response);
    const error = providerError(payload);
    if (!response.ok || payload?.success !== true) {
      return failure({
        pageId,
        detail: error?.message || `Meta Page subscription failed with ${response.status}.`,
        httpStatus: response.status,
        providerError: error,
        mutated: true,
      });
    }

    const after = await inspectMetaPageSubscription(pageId, pageAccessToken);
    if (!after.ok) {
      return failure({
        pageId,
        detail: `Meta accepted the Page subscription, but verification failed: ${after.detail}`,
        httpStatus: after.httpStatus,
        providerError: after.providerError,
        mutated: true,
      });
    }
    if (!after.subscribed) {
      return failure({
        pageId,
        detail: "Meta accepted the Page subscription, but the app is not present in subscribed_apps verification.",
        mutated: true,
      });
    }
    if (after.subscribedFields) {
      const missing = META_PAGE_SUBSCRIBED_FIELDS.filter((field) => !after.subscribedFields!.includes(field));
      if (missing.length) {
        return failure({
          pageId,
          detail: `Meta Page subscription is missing required webhook fields after update: ${missing.join(", ")}.`,
          mutated: true,
        });
      }
    }

    return {
      ...after,
      subscribedFields: after.subscribedFields ?? [...META_PAGE_SUBSCRIBED_FIELDS],
      mutated: true,
      detail: "Meta Page webhook subscription is active.",
    };
  } catch (error) {
    return failure({
      pageId,
      detail: error instanceof Error ? error.message : "Meta Page subscription failed.",
      mutated: true,
    });
  }
}

export async function unsubscribeMetaPageFromApp(
  pageId: string,
  pageAccessToken: string,
): Promise<MetaPageSubscriptionResult> {
  const appId = env().META_APP_ID || null;
  if (!appId) return failure({ pageId, detail: "META_APP_ID is not configured." });

  const url = new URL(
    `https://graph.facebook.com/${env().META_GRAPH_API_VERSION}/${encodeURIComponent(pageId)}/subscribed_apps`,
  );
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${pageAccessToken}` },
    });
    const body = await readJson(response);
    const error = providerError(body);
    if (!response.ok || body?.success !== true) {
      return failure({
        pageId,
        detail: error?.message || `Meta Page unsubscribe failed with ${response.status}.`,
        httpStatus: response.status,
        providerError: error,
        mutated: true,
      });
    }
    return {
      ok: true,
      subscribed: false,
      pageId,
      appId,
      requestedFields: [...META_PAGE_SUBSCRIBED_FIELDS],
      subscribedFields: [],
      mutated: true,
      detail: "Meta app was unsubscribed from this Page.",
    };
  } catch (error) {
    return failure({
      pageId,
      detail: error instanceof Error ? error.message : "Meta Page unsubscribe failed.",
      mutated: true,
    });
  }
}
