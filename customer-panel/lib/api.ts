export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "/api").replace(/\/$/, "");

const CSRF_STORAGE_KEY = "n8nauto.csrf";
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

export function getCsrfToken(): string | null {
  if (typeof window === "undefined") return null;

  // The readable CSRF cookie is created together with the authenticated session,
  // so it is authoritative for the browser's current session. localStorage is only
  // a fallback for environments where the cookie is temporarily unavailable.
  const cookieToken = readCsrfCookie();
  if (cookieToken) {
    if (window.localStorage.getItem(CSRF_STORAGE_KEY) !== cookieToken) {
      window.localStorage.setItem(CSRF_STORAGE_KEY, cookieToken);
    }
    return cookieToken;
  }

  return window.localStorage.getItem(CSRF_STORAGE_KEY);
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
