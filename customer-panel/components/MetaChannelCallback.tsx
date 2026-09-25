"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

type Membership = {
  tenant_id: string;
  tenant_name: string;
  role: string;
};

type DiscoveryPage = {
  id: string;
  name: string;
  instagram?: { id: string; username?: string } | null;
};

type Discovery = {
  id: string;
  tenantId: string;
  tenantName: string;
  businessId: string;
  requestedPlatform: "facebook" | "instagram";
  pages: DiscoveryPage[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to complete Meta connection.";
}

export default function MetaChannelCallback() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);

  const query = useMemo(() => {
    if (typeof window === "undefined") return { connectionId: "", metaError: "" };
    const params = new URLSearchParams(window.location.search);
    return {
      connectionId: params.get("metaConnection") || "",
      metaError: params.get("metaError") || "",
    };
  }, []);

  useEffect(() => {
    if (query.metaError) {
      setError(query.metaError);
      setLoading(false);
      return;
    }
    if (!query.connectionId) {
      window.location.replace("/");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const auth = await api<{ memberships?: Membership[] }>("/v1/auth/me");
        const memberships = auth?.memberships || [];
        if (!memberships.length) throw new Error("Your session has no tenant membership. Sign in again and retry the Meta connection.");

        let lastError: unknown = null;
        for (const membership of memberships) {
          try {
            const result = await api<{
              requestedPlatform: "facebook" | "instagram";
              businessId: string;
              pages: DiscoveryPage[];
            }>(`/v1/tenants/${membership.tenant_id}/channels/meta/oauth/discovery/${encodeURIComponent(query.connectionId)}`);
            if (cancelled) return;
            setDiscovery({
              ...result,
              id: query.connectionId,
              tenantId: membership.tenant_id,
              tenantName: membership.tenant_name,
            });
            return;
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError || new Error("Meta connection selection was not found or has expired.");
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query.connectionId, query.metaError]);

  async function complete(pageId: string, platform: "facebook" | "instagram") {
    if (!discovery) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/v1/tenants/${discovery.tenantId}/channels/meta/oauth/discovery/${encodeURIComponent(discovery.id)}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ pageId, platform }),
        },
      );
      window.location.replace("/?metaConnected=1");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="screen-center"><div className="spinner" />Loading your Meta Pages…</div>;
  }

  if (!discovery) {
    return (
      <main className="auth-shell">
        <section className="auth-card" style={{ maxWidth: 620, margin: "8vh auto" }}>
          <h1>Meta connection could not be completed</h1>
          <p>{error || "The authorization selection is missing or has expired."}</p>
          <button className="button primary" onClick={() => window.location.replace("/")}>Back to Customer Panel</button>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" style={{ maxWidth: 760, margin: "6vh auto" }}>
        <div className="stack">
          <div>
            <div className="eyebrow">{discovery.tenantName}</div>
            <h1>Choose Meta account</h1>
            <p>Select the Facebook Page to connect. Pages with a linked professional Instagram account can also be connected as Instagram.</p>
          </div>

          {error && <div className="alert error">{error}</div>}

          {(discovery.pages || []).map((page) => (
            <div className="list-row" key={page.id}>
              <div>
                <strong>{page.name}</strong>
                <span>
                  Page {page.id}
                  {page.instagram ? ` · Instagram @${page.instagram.username || page.instagram.id}` : ""}
                </span>
              </div>
              <div className="row">
                <button className="button" disabled={busy} onClick={() => complete(page.id, "facebook")}>Facebook</button>
                {page.instagram && (
                  <button className="button primary" disabled={busy} onClick={() => complete(page.id, "instagram")}>Instagram</button>
                )}
              </div>
            </div>
          ))}

          {!discovery.pages?.length && (
            <div className="empty">No manageable Facebook Pages were returned by Meta for this authorization.</div>
          )}

          <button className="button ghost" disabled={busy} onClick={() => window.location.replace("/")}>Cancel</button>
        </div>
      </section>
    </main>
  );
}
