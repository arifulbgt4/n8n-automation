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
  return result;
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

// Legacy exports retained temporarily so older locally cached admin bundles can
// compile during upgrade. The backend no longer registers or requires MFA.
export async function verifyMfa(_challengeToken: string, _code: string) {
  throw new ApiError(410, "MFA_DISABLED", "Super Admin MFA is disabled. Sign in with email and password.");
}

export async function reauthAdmin(_code: string) {
  return { ok: true };
}
