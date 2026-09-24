import type { NextRequest } from "next/server";
import { proxyApiRequest } from "@/lib/api-proxy";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

async function handler(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return proxyApiRequest(request, path);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export {
  handler as GET,
  handler as HEAD,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
};
