"use client";

import { FormEvent, KeyboardEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { api, qs } from "../lib/api";
import AgentCollectionSelector, { type AgentCollection } from "./AgentCollectionSelector";

type Agent = {
  id: string;
  business_id: string;
  name: string;
  description?: string | null;
  capabilities: string[];
  status: string;
  active_prompt_version?: number | null;
  channel_count?: number;
  collection_count?: number;
};
type Template = { key: string; name: string; description?: string | null; capabilities: string[] };
type AgentDetail = { collections?: { collection_id: string; priority: number }[] };

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === dialog || !dialog.contains(current))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (current === last || current === dialog || !dialog.contains(current))) { event.preventDefault(); first.focus(); }
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown} onMouseDown={(event) => event.stopPropagation()}><div className="modal-title"><h3 id={titleId}>{title}</h3><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div>{children}</div></div>;
}

export default function AgentManager({ tenantId, businessId, role, initialCapabilities = "" }: { tenantId: string; businessId: string; role?: string; initialCapabilities?: string }) {
  const canEdit = ["OWNER", "ADMIN", "STAFF"].includes(role || "");
  const canDelete = ["OWNER", "ADMIN"].includes(role || "");
  const [rows, setRows] = useState<Agent[]>([]);
  const [agentsReady, setAgentsReady] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [collections, setCollections] = useState<AgentCollection[]>([]);
  const [collectionsLoaded, setCollectionsLoaded] = useState(false);
  const [collectionsError, setCollectionsError] = useState("");
  const [collectionLoadAttempt, setCollectionLoadAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<{ agent: Agent; loading?: boolean; result?: { response: string; usage?: unknown }; error?: string } | null>(null);
  const [message, setMessage] = useState("What can you help me with?");
  const [form, setForm] = useState({ name: "", description: "", templateKey: "", capabilities: initialCapabilities });
  const [createCollectionIds, setCreateCollectionIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "", capabilities: "", status: "active" });
  const [editCollectionIds, setEditCollectionIds] = useState<string[]>([]);
  const [originalCollectionIds, setOriginalCollectionIds] = useState<string[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [editLoadError, setEditLoadError] = useState("");
  const editRequest = useRef(0);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const loading = !!businessId && !agentsReady && !error;
  const collectionsLoading = !!businessId && !collectionsLoaded && !collectionsError;
  const collectionsReady = collectionsLoaded && !collectionsError;
  const assignmentsChanged = !sameIds(editCollectionIds, originalCollectionIds);
  const unavailableSelected = editCollectionIds.some((id) => !collections.some((collection) => collection.id === id));
  const canSaveAssignments = !assignmentsChanged || (collectionsReady && !unavailableSelected);

  const load = useCallback(async () => {
    if (!tenantId || !businessId) return;
    const [agentsData, templatesData] = await Promise.all([
      api<{ agents?: Agent[] }>(`/v1/tenants/${tenantId}/agents${qs({ businessId })}`),
      api<{ templates?: Template[] }>(`/v1/tenants/${tenantId}/agent-templates`),
    ]);
    setRows((agentsData.agents ?? []).filter((agent) => agent.business_id === businessId));
    setTemplates(templatesData.templates ?? []);
    setAgentsReady(true);
  }, [tenantId, businessId]);

  useEffect(() => {
    if (!tenantId || !businessId) return;
    let cancelled = false;
    void Promise.all([
      api<{ agents?: Agent[] }>(`/v1/tenants/${tenantId}/agents${qs({ businessId })}`),
      api<{ templates?: Template[] }>(`/v1/tenants/${tenantId}/agent-templates`),
    ]).then(([agentsData, templatesData]) => {
      if (cancelled) return;
      setRows((agentsData.agents ?? []).filter((agent) => agent.business_id === businessId));
      setTemplates(templatesData.templates ?? []);
      setAgentsReady(true);
    }).catch((reason) => { if (!cancelled) setError(errorMessage(reason, "Unable to load agents.")); });
    return () => { cancelled = true; };
  }, [tenantId, businessId]);

  useEffect(() => {
    if (!tenantId || !businessId) return;
    let cancelled = false;
    void api<{ collections?: AgentCollection[] }>(`/v1/tenants/${tenantId}/collections${qs({ businessId })}`)
      .then((data) => {
        if (cancelled) return;
        setCollections((data.collections ?? []).filter((collection) => collection.business_id === businessId));
        setCollectionsLoaded(true);
      })
      .catch((reason) => { if (!cancelled) setCollectionsError(errorMessage(reason, "Unable to load collections.")); });
    return () => { cancelled = true; };
  }, [tenantId, businessId, collectionLoadAttempt]);

  function closeEdit() { if (busy) return; editRequest.current += 1; setEditing(null); setEditLoadError(""); setFormError(""); }
  function openCreate() { setCreateCollectionIds([]); setFormError(""); setOpen(true); }
  function closeCreate() { if (!busy) { setOpen(false); setFormError(""); } }
  function retryCollections() { setCollectionsLoaded(false); setCollectionsError(""); setCollectionLoadAttempt((attempt) => attempt + 1); }

  async function startEdit(agent: Agent) {
    const requestId = ++editRequest.current;
    setEditing(agent);
    setEditForm({ name: agent.name, description: agent.description || "", capabilities: (agent.capabilities || []).join(", "), status: agent.status === "draft" ? "draft" : "active" });
    setEditCollectionIds([]);
    setOriginalCollectionIds([]);
    setEditLoadError("");
    setFormError("");
    setEditLoading(true);
    try {
      const detail = await api<AgentDetail>(`/v1/tenants/${tenantId}/agents/${agent.id}`);
      if (editRequest.current === requestId) {
        const ids = (detail.collections ?? []).map((link) => link.collection_id);
        setEditCollectionIds(ids);
        setOriginalCollectionIds(ids);
      }
    } catch (reason) {
      if (editRequest.current === requestId) setEditLoadError(errorMessage(reason, "Unable to load the agent's collections."));
    } finally {
      if (editRequest.current === requestId) setEditLoading(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!businessId || !collectionsReady) return;
    setBusy("create");
    setFormError("");
    try {
      await api(`/v1/tenants/${tenantId}/agents`, {
        method: "POST",
        body: JSON.stringify({ businessId, name: form.name, description: form.description || undefined, templateKey: form.templateKey || undefined,
          capabilities: form.capabilities.split(",").map((value) => value.trim()).filter(Boolean), collectionIds: createCollectionIds }),
      });
      setForm({ name: "", description: "", templateKey: "", capabilities: initialCapabilities });
      setCreateCollectionIds([]);
      setOpen(false);
      setNotice("Agent created with the selected data sources.");
      void load().catch((reason) => setError(errorMessage(reason, "Unable to refresh agents.")));
    } catch (reason) { setFormError(errorMessage(reason, "Unable to create agent.")); }
    finally { setBusy(""); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || editLoading || editLoadError || !canSaveAssignments) return;
    setBusy(editing.id);
    setFormError("");
    try {
      await api(`/v1/tenants/${tenantId}/agents/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editForm.name, description: editForm.description,
          capabilities: editForm.capabilities.split(",").map((value) => value.trim()).filter(Boolean),
          ...(editForm.status !== editing.status ? { status: editForm.status } : {}),
          ...(assignmentsChanged ? { collectionIds: editCollectionIds } : {}) }),
      });
      closeEditAfterSave();
      setNotice(assignmentsChanged ? "Agent and data sources updated." : "Agent updated.");
      void load().catch((reason) => setError(errorMessage(reason, "Unable to refresh agents.")));
    } catch (reason) { setFormError(errorMessage(reason, "Unable to update agent.")); }
    finally { setBusy(""); }
  }

  function closeEditAfterSave() { editRequest.current += 1; setEditing(null); setEditLoadError(""); setFormError(""); }

  async function remove(agent: Agent) {
    if (!confirm(`Delete ${agent.name}? Linked channels will no longer use it, and open AI conversations will pause. History is retained.`)) return;
    setBusy(agent.id);
    setError("");
    try {
      await api(`/v1/tenants/${tenantId}/agents/${agent.id}`, { method: "DELETE" });
      setNotice(`${agent.name} deleted.`);
      await load();
    } catch (reason) { setError(errorMessage(reason, "Unable to delete agent.")); }
    finally { setBusy(""); }
  }

  async function run(agent: Agent) {
    try {
      setTest({ loading: true, agent });
      const result = await api<{ response: string; usage?: unknown }>(`/v1/tenants/${tenantId}/agents/${agent.id}/test`, { method: "POST", body: JSON.stringify({ message }) });
      setTest({ agent, result });
    } catch (reason) { setTest({ agent, error: errorMessage(reason, "Test failed.") }); }
  }

  const selectedTemplate = templates.find((template) => template.key === form.templateKey);
  const selectorLoading = collectionsLoading;

  return <>
    <div className="section-head"><div><h2>AI agents</h2><p>Create business agents and choose the collections they can search for live answers.</p></div>{canEdit && <button className="button primary" disabled={!businessId || !!busy} onClick={openCreate}>+ New agent</button>}</div>
    {error && <div role="alert" className="alert error">{error}</div>}
    {notice && <div role="status" className="alert success">{notice}</div>}
    {!businessId && <div className="alert warn">Choose a business to manage its agents and data sources.</div>}
    <div className="grid-list">
      {rows.map((agent) => <div className="entity-card" key={agent.id}><div className="entity-icon ai">AI</div><div className="grow"><div className="row-title"><strong>{agent.name}</strong><span className={`badge ${agent.status === "active" ? "good" : "neutral"}`}>{agent.status}</span></div><p>{agent.description || "Configurable business agent"}</p><div className="chips compact">{(agent.capabilities || []).slice(0, 6).map((capability) => <span key={capability}>{capability}</span>)}</div><small>Prompt v{agent.active_prompt_version || "—"} · {agent.channel_count || 0} channels · {agent.collection_count || 0} data sources</small></div><div className="row"><button className="button ghost smallbtn" onClick={() => void run(agent)}>Test</button>{canEdit && <button className="button ghost smallbtn" onClick={() => void startEdit(agent)}>Edit</button>}{canDelete && <button className="button danger smallbtn" disabled={busy === agent.id} onClick={() => void remove(agent)}>Delete</button>}</div></div>)}
      {loading ? <div className="empty">Loading agents…</div> : !rows.length && businessId && <div className="empty">No agents for this business yet.</div>}
    </div>
    {test && <Modal title={`Agent test · ${test.agent.name}`} onClose={() => setTest(null)}><div className="stack"><Field label="Customer message"><textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} /></Field><p className="muted small" style={{ margin: 0 }}>This quick test uses the agent prompt only. To verify live catalog answers, send a message through a connected channel.</p><button className="button primary" onClick={() => void run(test.agent)} disabled={test.loading}>{test.loading ? "Running…" : "Run test"}</button>{test.result && <div className="result-box"><strong>Response</strong><p>{test.result.response}</p><small>{JSON.stringify(test.result.usage)}</small></div>}{test.error && <div role="alert" className="alert error">{test.error}</div>}</div></Modal>}
    {open && <Modal title="Create AI agent" onClose={closeCreate}><form className="stack" onSubmit={create}>
      <Field label="Agent name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="Description"><textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></Field>
      <Field label="Starting template"><select value={form.templateKey} onChange={(event) => setForm({ ...form, templateKey: event.target.value })}><option value="">Blank / manual</option>{templates.map((template) => <option key={template.key} value={template.key}>{template.name}</option>)}</select></Field>
      {selectedTemplate && <div className="result-box"><b>{selectedTemplate.name}</b><p>{selectedTemplate.description}</p><small>{(selectedTemplate.capabilities || []).join(", ")}</small></div>}
      <Field label="Additional capabilities" hint="Optional comma-separated capability keys added on top of the template."><textarea rows={3} value={form.capabilities} onChange={(event) => setForm({ ...form, capabilities: event.target.value })} /></Field>
      <AgentCollectionSelector tenantId={tenantId} businessId={businessId} collections={collections} selectedIds={createCollectionIds} onChange={setCreateCollectionIds} loading={selectorLoading} loadError={collectionsError} onRetry={retryCollections} />
      {formError && <div role="alert" className="alert error">{formError}</div>}
      <button className="button primary" disabled={!!busy || !collectionsReady}>{busy ? "Creating…" : "Create agent"}</button>
    </form></Modal>}
    {editing && <Modal title="Edit AI agent" onClose={closeEdit}><form className="stack" onSubmit={save}>
      <Field label="Agent name"><input required value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} /></Field>
      <Field label="Description"><textarea rows={4} value={editForm.description} onChange={(event) => setEditForm({ ...editForm, description: event.target.value })} /></Field>
      <Field label="Capabilities" hint="Comma-separated capability keys"><input value={editForm.capabilities} onChange={(event) => setEditForm({ ...editForm, capabilities: event.target.value })} /></Field>
      <Field label="Status"><select value={editForm.status} onChange={(event) => setEditForm({ ...editForm, status: event.target.value })}><option value="active">Active</option><option value="draft">Draft</option></select></Field>
      {editLoading ? <p role="status" className="muted">Loading current collection assignments…</p> : editLoadError ? <div role="alert" className="alert error">{editLoadError}</div> : <AgentCollectionSelector tenantId={tenantId} businessId={businessId} collections={collections} selectedIds={editCollectionIds} onChange={setEditCollectionIds} loading={selectorLoading} loadError={collectionsError} onRetry={retryCollections} />}
      {formError && <div role="alert" className="alert error">{formError}</div>}
      <button className="button primary" disabled={!!busy || editLoading || !!editLoadError || !canSaveAssignments}>{busy ? "Saving…" : "Save agent"}</button>
    </form></Modal>}
  </>;
}
