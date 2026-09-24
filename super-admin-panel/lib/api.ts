export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");

const CSRF_KEY = "n8nauto.admin.csrf";

export function csrf() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CSRF_KEY)
    || decodeURIComponent(document.cookie.split("; ").find((x) => x.startsWith("n8nauto_csrf="))?.split("=")[1] || "")
    || null;
}

export function setCsrf(value: string | null) {
  if (typeof window === "undefined") return;
  if (value) localStorage.setItem(CSRF_KEY, value);
  else localStorage.removeItem(CSRF_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function redirectToMfaSetup<T>(): Promise<T> {
  if (typeof window !== "undefined" && window.location.pathname !== "/mfa-setup") {
    window.location.replace("/mfa-setup");
  }
  // Navigation will replace the current application tree. Keeping this promise pending
  // prevents React from surfacing the expected MFA-setup transition as an unhandled error.
  return new Promise<T>(() => undefined);
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body
    && !(typeof FormData !== "undefined" && init.body instanceof FormData)
    && !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }

  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    const token = csrf();
    if (token) headers.set("x-csrf-token", token);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = data?.error || {};
    if (error.code === "ADMIN_MFA_SETUP_REQUIRED") {
      return redirectToMfaSetup<T>();
    }
    throw new ApiError(
      response.status,
      error.code || "REQUEST_FAILED",
      error.message || `Request failed ${response.status}`,
      error.details,
    );
  }

  return data as T;
}

export async function signIn(email: string, password: string) {
  const result = await api<any>("/v1/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (result.csrfToken) setCsrf(result.csrfToken);
  if (result.mfaSetupRequired) return redirectToMfaSetup<any>();
  return result;
}

export async function verifyMfa(challengeToken: string, code: string) {
  const result = await api<any>("/v1/admin/auth/mfa", {
    method: "POST",
    body: JSON.stringify({ challengeToken, code }),
  });
  if (result.csrfToken) setCsrf(result.csrfToken);
  return result;
}

export async function getMfaStatus() {
  return api<any>("/v1/admin/mfa/status");
}

export async function startMfaSetup() {
  return api<{ secret: string; otpauthUri: string }>("/v1/admin/mfa/setup", {
    method: "POST",
    body: "{}",
  });
}

export async function confirmMfaSetup(code: string) {
  return api<{ ok: true; recoveryCodes: string[] }>("/v1/admin/mfa/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function signOut() {
  try {
    await api("/v1/auth/signout", { method: "POST" });
  } finally {
    setCsrf(null);
  }
}

export function qs(values: Record<string, unknown>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  });
  return params.size ? `?${params}` : "";
}

export async function reauthAdmin(code: string) {
  return api<any>("/v1/admin/mfa/reauth", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}
