"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
  const [search, setSearch] = useState("");
  const unavailableIds = selectedIds.filter((id) => !collections.some((collection) => collection.id === id));
  const visibleCollections = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    if (!term) return collections;
    return collections.filter((collection) => `${collection.name} ${collection.purpose ?? ""}`.toLocaleLowerCase().includes(term));
  }, [collections, search]);
  const allVisibleSelected = visibleCollections.length > 0 && visibleCollections.every((collection) => selectedIds.includes(collection.id));
  const toggle = (id: string) => onChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  function toggleVisible() {
    if (allVisibleSelected) {
      const visibleIds = new Set(visibleCollections.map((collection) => collection.id));
      onChange(selectedIds.filter((id) => !visibleIds.has(id)));
      return;
    }
    onChange(Array.from(new Set([...selectedIds, ...visibleCollections.map((collection) => collection.id)])));
  }

  return <fieldset className="agent-collection-selector">
    <legend>Data / Catalogs <span>{selectedIds.length} selected</span></legend>
    <p>Select the live data this agent can use. Each collection must also be linked to its channel in Data / Catalogs.</p>
    {loading ? <p role="status" className="muted small">Loading collections…</p> :
      loadError ? <div role="alert" className="stack"><span className="alert error">{loadError}</span><button type="button" className="button ghost smallbtn" onClick={onRetry}>Retry loading collections</button></div> :
        collections.length ? <>
          <label className="agent-selector-search"><span className="sr-only">Search collections</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search collections…" /></label>
          <div className="agent-selector-tools"><span>{visibleCollections.length} of {collections.length} collections</span><button type="button" className="link-button" onClick={toggleVisible} disabled={!visibleCollections.length}>{allVisibleSelected ? "Clear visible" : "Select visible"}</button></div>
          <div className="agent-collection-options">
            {visibleCollections.map((collection) => <label key={collection.id} className={`agent-collection-option${selectedIds.includes(collection.id) ? " selected" : ""}`}>
              <input type="checkbox" checked={selectedIds.includes(collection.id)} onChange={() => toggle(collection.id)} />
              <span className="grow"><strong>{collection.name}</strong><small>{collection.item_count ?? 0} items{collection.purpose ? ` · ${collection.purpose}` : ""}</small></span>
              {selectedIds.includes(collection.id) && <span className="badge brand">Selected</span>}
            </label>)}
            {!visibleCollections.length && <p className="agent-selector-empty">No collections match “{search}”.</p>}
          </div>
        </> : <p className="agent-selector-empty">No collections for this business. <Link href={`/${qs({ view: "data", tenantId, businessId })}`}>Create one in Data / Catalogs</Link> to give this agent live data access.</p>}
    {!loading && !loadError && unavailableIds.length > 0 && <div style={{ marginTop: 10 }}>
      <p className="agent-selector-warning">These linked collections are no longer available. Uncheck them before changing assignments.</p>
      {unavailableIds.map((id) => <label key={id} className="agent-collection-unavailable"><input type="checkbox" checked onChange={() => toggle(id)} /> Unavailable collection</label>)}
    </div>}
  </fieldset>;
}
