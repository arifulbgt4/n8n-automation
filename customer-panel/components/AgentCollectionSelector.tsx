"use client";

import Link from "next/link";
import { qs } from "../lib/api";

export type AgentCollection = {
  id: string;
  business_id: string;
  name: string;
  purpose?: string | null;
  item_count?: number;
};

export default function AgentCollectionSelector({ tenantId, businessId, collections, selectedIds, onChange, loading, loadError, onRetry }: {
  tenantId: string;
  businessId: string;
  collections: AgentCollection[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading: boolean;
  loadError: string;
  onRetry: () => void;
}) {
  const unavailableIds = selectedIds.filter((id) => !collections.some((collection) => collection.id === id));
  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);

  return <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 10, margin: 0, padding: 14, minWidth: 0 }}>
    <legend style={{ padding: "0 5px", fontWeight: 700 }}>Data / Catalogs · {selectedIds.length} selected</legend>
    <p style={{ margin: "0 0 11px", color: "#667085", fontSize: 13 }}>Select collections for live data answers. Each collection must also be linked to the channel in Data / Catalogs.</p>
    {loading ? <p role="status" style={{ margin: 0, color: "#667085" }}>Loading collections…</p> :
      loadError ? <div role="alert" style={{ color: "#b42318" }}><p style={{ margin: "0 0 8px" }}>{loadError}</p><button type="button" onClick={onRetry} style={{ border: 0, background: "transparent", padding: 0, color: "#4f46e5", fontWeight: 700, cursor: "pointer" }}>Retry loading collections</button></div> :
        collections.length ? <div style={{ display: "grid", gap: 8, maxHeight: 220, overflowY: "auto" }}>
          {collections.map((collection) => <label key={collection.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, border: "1px solid #e5e7eb", borderRadius: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={selectedIds.includes(collection.id)} onChange={() => toggle(collection.id)} style={{ width: "auto", marginTop: 3, accentColor: "#4f46e5" }} />
            <span><strong>{collection.name}</strong><small style={{ display: "block", marginTop: 3, color: "#667085" }}>{collection.item_count ?? 0} items{collection.purpose ? ` · ${collection.purpose}` : ""}</small></span>
          </label>)}
        </div> : <p style={{ margin: 0, color: "#667085" }}>No collections for this business. <Link href={`/${qs({ view: "data", tenantId, businessId })}`}>Create one in Data / Catalogs</Link> to give this agent live data access.</p>}
    {!loading && !loadError && unavailableIds.length > 0 && <div style={{ marginTop: 10 }}>
      <p style={{ margin: "0 0 7px", color: "#b42318", fontSize: 13 }}>These linked collections are no longer available. Uncheck them before changing assignments.</p>
      {unavailableIds.map((id) => <label key={id} style={{ display: "block", marginTop: 5 }}><input type="checkbox" checked onChange={() => toggle(id)} style={{ width: "auto" }} /> Unavailable collection</label>)}
    </div>}
  </fieldset>;
}
