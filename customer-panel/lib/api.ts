export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(/\/$/, "");

const CSRF_STORAGE_KEY = "n8nauto.csrf";

export function getCsrfToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(CSRF_STORAGE_KEY) || decodeURIComponent(document.cookie.split("; ").find((item) => item.startsWith("n8nauto_csrf="))?.split("=")[1] || "") || null;
}

export function setCsrfToken(value: string | null): void {
  if (typeof window === "undefined") return;
  if (value) window.localStorage.setItem(CSRF_STORAGE_KEY, value);
  else window.localStorage.removeItem(CSRF_STORAGE_KEY);
}

export class ApiClientError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const bodyIsForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body && !bodyIsForm && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())) {
    const csrf = getCsrfToken();
    if (csrf) headers.set("x-csrf-token", csrf);
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
    throw new ApiClientError(response.status, error.code || "REQUEST_FAILED", error.message || `Request failed with ${response.status}`, error.details);
  }
  return data as T;
}

export async function signIn(email: string, password: string) {
  const result = await api<any>("/v1/auth/signin", { method: "POST", body: JSON.stringify({ email, password }) });
  if (result.csrfToken) setCsrfToken(result.csrfToken);
  return result;
}

export async function signUp(input: { email: string; password: string; name: string; organizationName: string }) {
  const result = await api<any>("/v1/auth/signup", { method: "POST", body: JSON.stringify(input) });
  if (result.csrfToken) setCsrfToken(result.csrfToken);
  return result;
}

export async function signOut() {
  try { await api("/v1/auth/signout", { method: "POST" }); } finally { setCsrfToken(null); }
}

export function qs(values: Record<string, string | number | boolean | null | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  });
  const text = params.toString();
  return text ? `?${text}` : "";
}
