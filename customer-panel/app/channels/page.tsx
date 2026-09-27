"use client";

import { useEffect } from "react";
import { api } from "../../lib/api";

type Membership = { tenant_id: string };
type Discovery = { businessId: string };

export default function ChannelsReturnPage() {
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const target = new URL("/", window.location.origin);
    target.searchParams.set("view", "businesses");
    const connectionId = params.get("metaConnection");
    const providerError = params.get("metaError");
    if (providerError) {
      target.searchParams.set("metaError", providerError);
      window.location.replace(target.toString());
      return;
    }
    if (!connectionId) {
      window.location.replace(target.toString());
      return;
    }

    void (async () => {
      try {
        const auth = await api<{ memberships?: Membership[] }>("/v1/auth/me");
        for (const membership of auth.memberships ?? []) {
          try {
            const discovery = await api<Discovery>(
              "/v1/tenants/" + membership.tenant_id + "/channels/meta/oauth/discovery/" + encodeURIComponent(connectionId),
            );
            if (cancelled) return;
            target.searchParams.set("tenantId", membership.tenant_id);
            target.searchParams.set("businessId", discovery.businessId);
            target.searchParams.set("metaConnection", connectionId);
            window.location.replace(target.toString());
            return;
          } catch {
            // The discovery belongs to a different membership or has expired.
          }
        }
        throw new Error("The Meta connection expired. Please start again from your business.");
      } catch (reason) {
        if (cancelled) return;
        target.searchParams.set("metaError", reason instanceof Error ? reason.message : "Unable to resume Meta connection.");
        window.location.replace(target.toString());
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return <div className="screen-center"><div className="spinner" />Returning to your business…</div>;
}
