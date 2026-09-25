"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, qs } from "../../lib/api";

type Membership = { tenant_id: string; tenant_name: string; role: string };
type Business = { id: string; name: string };
type Channel = {
  id: string;
  business_id: string;
  name: string;
  platform: string;
  connection_status: string;
  default_agent_profile_id: string | null;
};
type Agent = {
  id: string;
  business_id: string;
  name: string;
  status: string;
  active_prompt_version: number | null;
  active_prompt_version_id: string | null;
};

export default function ChannelAiPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selection, setSelection] = useState<Record<string, string>>( {} );
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<any>("/v1/auth/me")
      .then((data) => {
        const rows = data?.memberships ?? [];
        setMemberships(rows);
        setTenantId(rows[0]?.tenant_id ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load account."));
  }, []);

  useEffect(() => {
    if (!tenantId) return;
    api<any>(`/v1/tenants/${tenantId}/businesses`)
      .then((data) => {
        const rows = data.businesses ?? [];
        setBusinesses(rows);
        setBusinessId((current) => rows.some((b: Business) => b.id === current) ? current : (rows[0]?.id ?? ""));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load businesses."));
  }, [tenantId]);

  const load = useCallback(async () => {
    if (!tenantId || !businessId) return;
    setError("");
    const [channelData, agentData] = await Promise.all([
      api<any>(`/v1/tenants/${tenantId}/channels${qs({ businessId })}`),
      api<any>(`/v1/tenants/${tenantId}/agents${qs({ businessId })}`),
    ]);
    const channelRows: Channel[] = channelData.channels ?? [];
    const agentRows: Agent[] = agentData.agents ?? [];
    setChannels(channelRows);
    setAgents(agentRows);
    setSelection(Object.fromEntries(channelRows.map((channel) => [channel.id, channel.default_agent_profile_id ?? ""])));
  }, [tenantId, businessId]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Unable to load AI assignments."));
  }, [load]);

  const eligibleAgents = useMemo(
    () => agents.filter((agent) => agent.status === "active" && Boolean(agent.active_prompt_version_id || agent.active_prompt_version)),
    [agents],
  );

  async function save(channel: Channel) {
    const agentProfileId = selection[channel.id] || null;
    setBusy(channel.id);
    setError("");
    setNotice("");
    try {
      const result = await api<any>(`/v1/tenants/${tenantId}/channels/${channel.id}/default-agent`, {
        method: "PUT",
        body: JSON.stringify({ agentProfileId, backfillOpenConversations: true }),
      });
      setNotice(
        agentProfileId
          ? `Default AI agent saved for ${channel.name}. Recovered ${result.backfilledOpenConversations ?? 0} open conversation(s).`
          : `Default AI agent cleared for ${channel.name}.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update channel AI agent.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "36px 24px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 24 }}>
        <div>
          <div style={{ color: "#6b7280", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" }}>Customer Panel</div>
          <h1 style={{ margin: "6px 0" }}>Channel AI setup</h1>
          <p style={{ color: "#6b7280", margin: 0 }}>Choose the default AI agent for each connected channel. AI providers and task models are configured centrally by the platform administrator.</p>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          <Link href="/usage" style={{ color: "#4f46e5", fontWeight: 700, textDecoration: "none" }}>Monthly AI usage</Link>
          <Link href="/" style={{ color: "#4f46e5", fontWeight: 700, textDecoration: "none" }}>← Dashboard</Link>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13, color: "#6b7280" }}>Workspace</span>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} style={{ padding: 10, borderRadius: 8, border: "1px solid #d1d5db" }}>
            {memberships.map((m) => <option key={m.tenant_id} value={m.tenant_id}>{m.tenant_name} · {m.role}</option>)}
          </select>
        </label>
        <label style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 13, color: "#6b7280" }}>Business</span>
          <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} style={{ padding: 10, borderRadius: 8, border: "1px solid #d1d5db" }}>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, background: "#fef2f2", color: "#991b1b" }}>{error}</div>}
      {notice && <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, background: "#ecfdf5", color: "#065f46" }}>{notice}</div>}

      {!eligibleAgents.length && (
        <div style={{ padding: 16, marginBottom: 18, borderRadius: 10, border: "1px solid #f59e0b", background: "#fffbeb" }}>
          <strong>No active AI agent with an active prompt is available for this business.</strong>
          <div style={{ marginTop: 6, color: "#92400e" }}>Return to Dashboard → AI Agents and create an agent. Provider credentials and model routes are supplied by the platform, not by customer workspaces.</div>
        </div>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {channels.map((channel) => (
          <section key={channel.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 18, background: "white", display: "grid", gridTemplateColumns: "minmax(220px,1fr) minmax(280px,1.4fr) auto", gap: 16, alignItems: "end" }}>
            <div>
              <strong style={{ display: "block", fontSize: 16 }}>{channel.name}</strong>
              <span style={{ color: "#6b7280", fontSize: 13 }}>{channel.platform} · {channel.connection_status}</span>
            </div>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>Default AI agent</span>
              <select
                value={selection[channel.id] ?? ""}
                onChange={(e) => setSelection((current) => ({ ...current, [channel.id]: e.target.value }))}
                style={{ padding: 10, borderRadius: 8, border: "1px solid #d1d5db" }}
              >
                <option value="">No default agent</option>
                {eligibleAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · prompt v{agent.active_prompt_version ?? "active"}</option>)}
              </select>
            </label>
            <button
              onClick={() => void save(channel)}
              disabled={busy === channel.id}
              style={{ padding: "10px 16px", borderRadius: 8, border: 0, background: "#4f46e5", color: "white", fontWeight: 700, cursor: "pointer" }}
            >
              {busy === channel.id ? "Saving…" : "Save"}
            </button>
          </section>
        ))}
        {!channels.length && <div style={{ padding: 20, border: "1px dashed #d1d5db", borderRadius: 12, color: "#6b7280" }}>No channels found for this business.</div>}
      </div>
    </main>
  );
}
