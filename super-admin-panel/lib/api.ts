export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");

const CSRF_KEY = "n8nauto.admin.csrf";
const CSRF_COOKIE_NAME = "n8nauto_csrf";

function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${CSRF_COOKIE_NAME}=`))
    ?.slice(CSRF_COOKIE_NAME.length + 1);
  if (!raw) return null;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

export function csrf() {
  if (typeof window === "undefined") return null;

  // Keep the CSRF header bound to the browser's current authenticated session.
  // The readable CSRF cookie is authoritative; localStorage is only a fallback.
  const cookieToken = readCsrfCookie();
  if (cookieToken) {
    if (localStorage.getItem(CSRF_KEY) !== cookieToken) localStorage.setItem(CSRF_KEY, cookieToken);
    return cookieToken;
  }

  return localStorage.getItem(CSRF_KEY);
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

export async function completeMfa(challengeToken: string, code: string) {
  const result = await api<any>("/v1/admin/auth/mfa", {
    method: "POST",
    body: JSON.stringify({ challengeToken, code }),
  });
  if (result.csrfToken) setCsrf(result.csrfToken);
  return result;
}

export async function reauthenticateMfa(code: string) {
  return api<{ ok: true; mfaVerifiedAt: string }>("/v1/admin/mfa/reauth", {
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
