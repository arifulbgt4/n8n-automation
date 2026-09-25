"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

type Membership = { tenant_id: string; tenant_name: string; role: string };
type Business = { id: string; name: string };
type Provider = {
  id: string;
  business_id: string | null;
  name: string;
  provider: string;
  status: string;
  key_hint?: string | null;
};
type CatalogModel = { id: string; label: string; ownedBy?: string | null; methods?: string[] };
type ModelRoute = {
  id: string;
  business_id: string | null;
  provider_connection_id: string;
  provider_name?: string;
  provider?: string;
  task_key: string;
  model: string;
  active: boolean;
};

const taskKeys = [
  "DEFAULT_CHAT",
  "IMAGE_ANALYSIS",
  "AUDIO_TRANSCRIPTION",
  "PROMPT_SYNTHESIS",
  "EMBEDDINGS",
  "STRUCTURED_EXTRACTION",
] as const;

export default function AiModelsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [providerId, setProviderId] = useState("");
  const [taskKey, setTaskKey] = useState<(typeof taskKeys)[number]>("DEFAULT_CHAT");
  const [model, setModel] = useState("");
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api<any>("/v1/auth/me")
      .then((data) => {
        const rows = data?.memberships ?? [];
        setMemberships(rows);
        setTenantId(rows[0]?.tenant_id ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Unable to load account."));
  }, []);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setError("");
    const [businessData, providerData, routeData] = await Promise.all([
      api<any>(`/v1/tenants/${tenantId}/businesses`),
      api<any>(`/v1/tenants/${tenantId}/ai/providers`),
      api<any>(`/v1/tenants/${tenantId}/ai/models`),
    ]);
    const businessRows: Business[] = businessData.businesses ?? [];
    const providerRows: Provider[] = providerData.providers ?? [];
    setBusinesses(businessRows);
    setBusinessId((current) => businessRows.some((b) => b.id === current) ? current : (businessRows[0]?.id ?? ""));
    setProviders(providerRows);
    setRoutes(routeData.models ?? []);
    setProviderId((current) => providerRows.some((p) => p.id === current) ? current : (providerRows[0]?.id ?? ""));
  }, [tenantId]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Unable to load AI configuration."));
  }, [load]);

  const selectedProvider = useMemo(() => providers.find((p) => p.id === providerId) ?? null, [providers, providerId]);

  const loadCatalog = useCallback(async () => {
    if (!tenantId || !providerId) {
      setCatalog([]);
      return;
    }
    setLoadingCatalog(true);
    setError("");
    try {
      const data = await api<any>(`/v1/tenants/${tenantId}/ai/providers/${providerId}/catalog`);
      setCatalog(data.models ?? []);
      if ((data.models ?? []).length === 1) setModel(data.models[0].id);
    } catch (e) {
      setCatalog([]);
      setError(e instanceof Error ? e.message : "Unable to load provider models. You can still enter a model ID manually.");
    } finally {
      setLoadingCatalog(false);
    }
  }, [tenantId, providerId]);

  useEffect(() => {
    setModel("");
    setCatalog([]);
    if (providerId) void loadCatalog();
  }, [providerId, loadCatalog]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!providerId || !model.trim()) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (taskKey === "DEFAULT_CHAT") {
        const test = await api<any>(`/v1/tenants/${tenantId}/ai/providers/${providerId}/test`, {
          method: "POST",
          body: JSON.stringify({ model: model.trim() }),
        });
        if (!test.ok) throw new Error(`Model test failed: ${test.detail || "provider rejected the model"}`);
      }

      await api(`/v1/tenants/${tenantId}/ai/models`, {
        method: "POST",
        body: JSON.stringify({
          businessId: businessId || null,
          providerConnectionId: providerId,
          taskKey,
          model: model.trim(),
          parameters: {},
        }),
      });
      setNotice(`${taskKey} route saved with ${model.trim()}.`);
      const routeData = await api<any>(`/v1/tenants/${tenantId}/ai/models`);
      setRoutes(routeData.models ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save model route.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ maxWidth: 1150, margin: "0 auto", padding: "36px 24px", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center", marginBottom: 24 }}>
        <div>
          <div style={{ color: "#6b7280", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" }}>Customer Panel</div>
          <h1 style={{ margin: "6px 0" }}>AI provider models</h1>
          <p style={{ color: "#6b7280", margin: 0 }}>Load the models available to your provider API key, test a chat model, and save the task route. Manual model IDs remain supported for compatible providers.</p>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          <Link href="/channel-ai" style={{ color: "#4f46e5", fontWeight: 700, textDecoration: "none" }}>Channel AI setup</Link>
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
          <span style={{ fontSize: 13, color: "#6b7280" }}>Business scope</span>
          <select value={businessId} onChange={(e) => setBusinessId(e.target.value)} style={{ padding: 10, borderRadius: 8, border: "1px solid #d1d5db" }}>
            <option value="">Tenant-wide</option>
            {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
      </div>

      {error && <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, background: "#fef2f2", color: "#991b1b" }}>{error}</div>}
      {notice && <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, background: "#ecfdf5", color: "#065f46" }}>{notice}</div>}

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 20, background: "white", marginBottom: 24 }}>
        <h2 style={{ marginTop: 0 }}>Create model route</h2>
        <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Provider connection</span>
            <select required value={providerId} onChange={(e) => setProviderId(e.target.value)} style={{ padding: 11, borderRadius: 8, border: "1px solid #d1d5db" }}>
              <option value="">Select provider…</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.provider} · {p.status}</option>)}
            </select>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>Task</span>
              <select value={taskKey} onChange={(e) => setTaskKey(e.target.value as (typeof taskKeys)[number])} style={{ padding: 11, borderRadius: 8, border: "1px solid #d1d5db" }}>
                {taskKeys.map((task) => <option key={task}>{task}</option>)}
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 13, color: "#6b7280" }}>Provider model ID</span>
              <input
                list="provider-model-catalog"
                required
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={loadingCatalog ? "Loading provider models…" : "Select or type a model ID"}
                style={{ padding: 11, borderRadius: 8, border: "1px solid #d1d5db" }}
              />
              <datalist id="provider-model-catalog">
                {catalog.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </datalist>
            </label>
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ color: "#6b7280", fontSize: 13 }}>
              {selectedProvider ? `${selectedProvider.provider} · ${catalog.length} model(s) discovered${selectedProvider.key_hint ? ` · key ${selectedProvider.key_hint}` : ""}` : "Select a provider first."}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => void loadCatalog()} disabled={!providerId || loadingCatalog} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "white", fontWeight: 700 }}>
                {loadingCatalog ? "Loading…" : "Refresh models"}
              </button>
              <button disabled={saving || !providerId || !model.trim()} style={{ padding: "10px 16px", borderRadius: 8, border: 0, background: "#4f46e5", color: "white", fontWeight: 700 }}>
                {saving ? "Testing & saving…" : "Save model route"}
              </button>
            </div>
          </div>
        </form>
      </section>

      <section style={{ border: "1px solid #e5e7eb", borderRadius: 14, padding: 20, background: "white" }}>
        <h2 style={{ marginTop: 0 }}>Existing model routes</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ textAlign: "left", padding: 10 }}>Provider</th><th style={{ textAlign: "left", padding: 10 }}>Task</th><th style={{ textAlign: "left", padding: 10 }}>Model</th><th style={{ textAlign: "left", padding: 10 }}>Scope</th><th style={{ textAlign: "left", padding: 10 }}>Status</th></tr></thead>
            <tbody>
              {routes.map((route) => (
                <tr key={route.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: 10 }}>{route.provider_name || route.provider || route.provider_connection_id}</td>
                  <td style={{ padding: 10 }}>{route.task_key}</td>
                  <td style={{ padding: 10 }}><code>{route.model}</code></td>
                  <td style={{ padding: 10 }}>{businesses.find((b) => b.id === route.business_id)?.name || "Tenant-wide"}</td>
                  <td style={{ padding: 10 }}>{route.active ? "active" : "inactive"}</td>
                </tr>
              ))}
              {!routes.length && <tr><td colSpan={5} style={{ padding: 16, color: "#6b7280" }}>No model routes configured yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
