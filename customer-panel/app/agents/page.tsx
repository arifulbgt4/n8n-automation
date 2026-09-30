"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AgentManager from "../../components/AgentManager";
import { api } from "../../lib/api";

type Membership = { tenant_id: string; tenant_name: string; role: string };
type Business = { id: string; name: string };

const input = { padding: 10, borderRadius: 8, border: "1px solid #d1d5db", width: "100%" } as const;
const button = { padding: "9px 13px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontWeight: 700 } as const;

export default function AgentsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [businessId, setBusinessId] = useState("");
  const [businessState, setBusinessState] = useState<{ tenantId: string; rows: Business[] }>({ tenantId: "", rows: [] });
  const [error, setError] = useState("");
  const businesses = businessState.tenantId === tenantId ? businessState.rows : [];
  const role = memberships.find((membership) => membership.tenant_id === tenantId)?.role;

  useEffect(() => {
    let cancelled = false;
    void api<{ memberships?: Membership[] }>("/v1/auth/me")
      .then((data) => {
        if (cancelled) return;
        const rows = data.memberships ?? [];
        setMemberships(rows);
        setTenantId(rows[0]?.tenant_id ?? "");
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load account."); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    void api<{ businesses?: Business[] }>(`/v1/tenants/${tenantId}/businesses`)
      .then((data) => {
        if (cancelled) return;
        const rows = data.businesses ?? [];
        setBusinessState({ tenantId, rows });
        setBusinessId((current) => rows.some((row) => row.id === current) ? current : (rows[0]?.id ?? ""));
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load businesses."); });
    return () => { cancelled = true; };
  }, [tenantId]);

  return <main style={{ maxWidth: 1150, margin: "0 auto", padding: "34px 24px", background: "#f8fafc", minHeight: "100vh" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, marginBottom: 20 }}>
      <div><div style={{ fontSize: 12, fontWeight: 800, color: "#6b7280", textTransform: "uppercase" }}>Customer Panel</div><h1 style={{ margin: "5px 0" }}>AI Agents</h1></div>
      <Link href="/" style={{ ...button, textDecoration: "none", color: "#111827" }}>← Dashboard</Link>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 12, marginBottom: 20 }}>
      <label>Workspace<select style={input} value={tenantId} onChange={(event) => { setTenantId(event.target.value); setBusinessId(""); }}>
        {memberships.map((membership) => <option key={membership.tenant_id} value={membership.tenant_id}>{membership.tenant_name} · {membership.role}</option>)}
      </select></label>
      <label>Business<select style={input} value={businessId} onChange={(event) => setBusinessId(event.target.value)}>
        {businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}
      </select></label>
    </div>
    {error && <div role="alert" className="alert error" style={{ marginBottom: 16 }}>{error}</div>}
    <AgentManager key={`${tenantId}:${businessId}`} tenantId={tenantId} businessId={businessId} role={role} initialCapabilities="DATA_SEARCH,FAQ_KNOWLEDGE,HUMAN_HANDOFF" />
  </main>;
}
