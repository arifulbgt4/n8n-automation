import type { NextRequest } from "next/server";

const DEFAULT_API_PROXY_TARGET = "http://localhost:4000";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "accept-encoding",
]);

function apiTarget(): URL {
  const raw = (process.env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET).trim();
  const target = new URL(raw);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error("API_PROXY_TARGET must use http or https");
  }
  return target;
}

function buildUpstreamUrl(request: NextRequest, path: string[]): URL {
  const target = apiTarget();
  const prefix = target.pathname.replace(/\/+$/, "");
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  target.pathname = `${prefix}/${encodedPath}` || "/";
  target.search = "";
  request.nextUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));
  return target;
}

function buildRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  return headers;
}

function rewriteSetCookieForLocalDevelopment(value: string): string {
  if (process.env.API_PROXY_INSECURE_COOKIES !== "true") return value;
  return value
    .replace(/;\s*Secure\b/gi, "")
    .replace(/;\s*Domain=[^;]+/gi, "");
}

function buildResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();

  upstreamHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "set-cookie" ||
      lower === "content-length" ||
      lower === "content-encoding" ||
      HOP_BY_HOP_HEADERS.has(lower)
    ) {
      return;
    }
    headers.set(key, value);
  });

  const getSetCookie = (upstreamHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = getSetCookie ? getSetCookie.call(upstreamHeaders) : [];
  if (!cookies.length) {
    const fallback = upstreamHeaders.get("set-cookie");
    if (fallback) cookies.push(fallback);
  }

  for (const cookie of cookies) {
    headers.append("set-cookie", rewriteSetCookieForLocalDevelopment(cookie));
  }

  return headers;
}

export async function proxyApiRequest(request: NextRequest, path: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: buildRequestHeaders(request),
    redirect: "manual",
    cache: "no-store",
  };

  if (!["GET", "HEAD"].includes(method) && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(buildUpstreamUrl(request, path), init);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: buildResponseHeaders(upstream.headers),
    });
  } catch (error) {
    console.error("Customer Panel API proxy request failed", error);
    return Response.json(
      { error: { code: "API_PROXY_UNAVAILABLE", message: "The SaaS API is unavailable." } },
      { status: 502 },
    );
  }
}
