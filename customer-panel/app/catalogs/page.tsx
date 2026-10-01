"use client";

import Link from "next/link";
import Image from "next/image";
import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { API_URL, api, qs } from "../../lib/api";

type Membership = { tenant_id: string; tenant_name: string; role: string };
type Business = { id: string; name: string };
type Channel = { id: string; name: string; platform: string };
type Collection = {
  id: string;
  business_id: string;
  name: string;
  purpose: string | null;
  is_transactional_source: boolean;
  schema_version: number;
  field_count?: number;
  item_count?: number;
  channel_count?: number;
  preview_image?: { id: string; url: string | null; mimeType: string } | null;
};
type FieldRow = {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  searchable?: boolean;
  filterable?: boolean;
  sortable?: boolean;
  ai_visible?: boolean;
  options_json?: Record<string, unknown>;
  validation_json?: Record<string, unknown>;
  display_order?: number;
};
type ItemValue = string | number | boolean | string[] | Record<string, unknown> | null | undefined;
type ItemMedia = { id: string; url: string | null; mimeType: string; role: string; order: number };
type Item = { id: string; title?: string | null; status: string; data_jsonb: Record<string, ItemValue>; updated_at: string; media?: ItemMedia[] };
type Asset = { id: string; original_name?: string | null; mime_type: string; public_url?: string | null };
type CatalogsPageProps = {
  embedded?: boolean;
  tenantId?: string;
  businessId?: string;
  onChanged?: () => void;
};

type CollectionDraft = { name: string; template: "product" | "service" | "property" | "menu" | "package" | "blank" };
type FieldDraft = {
  key: string;
  label: string;
  type: string;
  choices: string;
  targetCollectionId: string;
  required: boolean;
  searchable: boolean;
  filterable: boolean;
  sortable: boolean;
  aiVisible: boolean;
};

const card = { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 18 } as const;
const control = { width: "100%", border: "1px solid #d1d5db", borderRadius: 8, padding: "10px 11px", font: "inherit", background: "#fff" } as const;
const button = { border: 0, borderRadius: 8, padding: "10px 14px", fontWeight: 750, cursor: "pointer" } as const;

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: ReactNode; hint?: string }) {
  return <label style={{ display: "grid", gap: 6 }}><span style={{ fontSize: 13, fontWeight: 700, color: "#344054" }}>{label}{required && <span style={{ color: "#dc2626" }}> *</span>}</span>{children}{hint && <small style={{ color: "#667085" }}>{hint}</small>}</label>;
}

function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return <div onMouseDown={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", display: "grid", placeItems: "center", padding: 20, zIndex: 100 }}><div onMouseDown={(event) => event.stopPropagation()} style={{ width: "min(820px,96vw)", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 16, boxShadow: "0 24px 80px rgba(15,23,42,.3)", padding: 22 }}>{children}</div></div>;
}

function seedFor(field: FieldRow): unknown {
  if (field.type === "boolean") return false;
  if (field.type === "integer" || field.type === "decimal" || field.type === "currency") return "";
  if (field.type === "multi_select" || field.type === "media") return [];
  if (field.type === "json") return {};
  return "";
}

function mediaIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" && value ? [value] : [];
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatItemValue(value: ItemValue) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "—");
}

function CatalogItemMedia({ item, tenantId }: { item: Item; tenantId: string }) {
  const images = (item.media ?? []).filter((media) => media.mimeType?.startsWith("image/"));
  if (!images.length) {
    return <div className="catalog-item-media-empty" aria-label="No image">
      <span aria-hidden="true">▧</span>
      <small>No image</small>
    </div>;
  }

  return <div className="catalog-item-media-preview" aria-label={images.length + " images for " + (item.title || "catalog item")}>
    {images.slice(0, 2).map((image, index) => <div className="catalog-item-media-thumb" key={image.id}>
      <Image
        src={image.url || API_URL + "/v1/tenants/" + tenantId + "/media/" + image.id + "/content"}
        alt={(item.title || "Catalog item") + " image " + (index + 1)}
        width={56}
        height={56}
        sizes="56px"
        unoptimized
      />
    </div>)}
    {images.length > 2 && <span className="catalog-item-media-more">+{images.length - 2}</span>}
  </div>;
}

function CollectionPreview({ collection, tenantId }: { collection: Collection; tenantId: string }) {
  const preview = collection.preview_image;
  if (preview?.mimeType?.startsWith("image/")) {
    return <div className="catalog-collection-preview">
      <Image
        src={preview.url || API_URL + "/v1/tenants/" + tenantId + "/media/" + preview.id + "/content"}
        alt={collection.name + " catalog preview"}
        width={440}
        height={168}
        sizes="(max-width: 700px) 90vw, (max-width: 1100px) 45vw, 360px"
        unoptimized
      />
      <span>{collection.item_count ?? 0} item{collection.item_count === 1 ? "" : "s"}</span>
    </div>;
  }
  return <div className="catalog-collection-preview catalog-collection-preview-empty" aria-label="No catalog image yet">
    <span aria-hidden="true">▧</span>
    <small>Add an item image to preview this collection</small>
  </div>;
}

export default function CatalogsPage({ embedded = false, tenantId: suppliedTenantId, businessId: suppliedBusinessId, onChanged }: CatalogsPageProps) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const tenantId = suppliedTenantId ?? selectedTenantId;
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const businessId = suppliedBusinessId ?? selectedBusinessId;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [linkedChannelIds, setLinkedChannelIds] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [queryText, setQueryText] = useState("");
  const [editing, setEditing] = useState<Item | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionEditing, setCollectionEditing] = useState<Collection | null>(null);
  const [collectionEdit, setCollectionEdit] = useState({ name: "", purpose: "", isTransactionalSource: false });
  const [fieldOpen, setFieldOpen] = useState(false);
  const [fieldEditing, setFieldEditing] = useState<FieldRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [collectionDraft, setCollectionDraft] = useState<CollectionDraft>({ name: "", template: "product" });
  const [fieldDraft, setFieldDraft] = useState<FieldDraft>({ key: "", label: "", type: "text", choices: "", targetCollectionId: "", required: false, searchable: true, filterable: false, sortable: false, aiVisible: true });
  const [relatedItems, setRelatedItems] = useState<Record<string, Item[]>>({});
  const [importText, setImportText] = useState("[]");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (suppliedTenantId !== undefined) return;
    void api<{ memberships?: Membership[] }>("/v1/auth/me")
      .then((data) => {
        const rows = data.memberships ?? [];
        setMemberships(rows);
        setSelectedTenantId(rows[0]?.tenant_id ?? "");
      })
      .catch((reason) => setError(errorMessage(reason, "Unable to load account.")));
  }, [suppliedTenantId]);

  useEffect(() => {
    if (suppliedBusinessId !== undefined) return;
    if (!tenantId) return;
    void api<{ businesses?: Business[] }>(`/v1/tenants/${tenantId}/businesses`)
      .then((data) => {
        const rows = data.businesses ?? [];
        setBusinesses(rows);
        setSelectedBusinessId((current) => {
          return rows.some((business) => business.id === current) ? current : (rows[0]?.id ?? "");
        });
      })
      .catch((reason) => setError(errorMessage(reason, "Unable to load businesses.")));
  }, [tenantId, suppliedBusinessId]);

  const loadCollections = useCallback(async (resetScope = false) => {
    if (resetScope) {
      setSelected(null);
      setFields([]);
      setItems([]);
      setLinkedChannelIds([]);
      setCollectionEditing(null);
      setFieldEditing(null);
      setFormOpen(false);
      setCollectionOpen(false);
      setFieldOpen(false);
      setImportOpen(false);
    }
    if (!tenantId || !businessId) {
      setCollections([]);
      return;
    }
    const data = await api<{ collections?: Collection[] }>(`/v1/tenants/${tenantId}/collections${qs({ businessId })}`);
    setCollections(data.collections ?? []);
  }, [tenantId, businessId]);

  useEffect(() => {
    async function refreshScope() {
      try {
        await loadCollections(true);
      } catch (reason) {
        setError(errorMessage(reason, "Unable to load collections."));
      }
    }
    void refreshScope();
  }, [loadCollections]);

  const loadItems = useCallback(async (collection: Collection, query = queryText) => {
    const data = await api<{ items?: Item[] }>(`/v1/tenants/${tenantId}/collections/${collection.id}/items${qs({ q: query || undefined })}`);
    setItems(data.items ?? []);
  }, [tenantId, queryText]);

  async function openCollection(collection: Collection) {
    setBusy(true);
    setError("");
    try {
      const [detail, media, channelData] = await Promise.all([
        api<{ collection: Collection; fields?: FieldRow[]; channels?: Channel[] }>(`/v1/tenants/${tenantId}/collections/${collection.id}`),
        api<{ assets?: Asset[] }>(`/v1/tenants/${tenantId}/media${qs({ businessId: collection.business_id })}`).catch(() => ({ assets: [] })),
        api<{ channels?: Channel[] }>(`/v1/tenants/${tenantId}/channels${qs({ businessId: collection.business_id })}`).catch(() => ({ channels: [] })),
      ]);
      const full = detail.collection;
      const rows = (detail.fields ?? []).sort((left, right) => (left.display_order ?? 0) - (right.display_order ?? 0));
      const relations = rows.filter((field) => field.type === "relation" && typeof field.options_json?.targetCollectionId === "string");
      const relationResults = await Promise.all(relations.map(async (field) => {
        const targetId = String(field.options_json?.targetCollectionId);
        const response = await api<{ items?: Item[] }>(`/v1/tenants/${tenantId}/collections/${targetId}/items${qs({ limit: 200 })}`).catch(() => ({ items: [] }));
        return [field.key, response.items ?? []] as const;
      }));
      setSelected(full);
      setFields(rows);
      setRelatedItems(Object.fromEntries(relationResults));
      setLinkedChannelIds((detail.channels ?? []).map((channel) => channel.id));
      setChannels(channelData.channels ?? []);
      setAssets(media.assets ?? []);
      await loadItems(full, "");
    } catch (reason) {
      setError(errorMessage(reason, "Unable to open this collection."));
    } finally {
      setBusy(false);
    }
  }

  async function createCollection(event: FormEvent) {
    event.preventDefault();
    if (!tenantId || !businessId) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ collection: Collection }>(`/v1/tenants/${tenantId}/collections`, {
        method: "POST",
        body: JSON.stringify({ businessId, name: collectionDraft.name, template: collectionDraft.template }),
      });
      setCollectionDraft({ name: "", template: "product" });
      setCollectionOpen(false);
      setNotice("Collection created. Add your first item using normal form fields.");
      await loadCollections();
      onChanged?.();
      await openCollection(response.collection);
    } catch (reason) {
      setError(errorMessage(reason, "Unable to create collection."));
    } finally {
      setBusy(false);
    }
  }

  function startEditCollection(collection: Collection) {
    setCollectionEditing(collection);
    setCollectionEdit({ name: collection.name, purpose: collection.purpose ?? "", isTransactionalSource: collection.is_transactional_source });
    setError("");
  }

  async function saveCollection(event: FormEvent) {
    event.preventDefault();
    if (!collectionEditing) return;
    setBusy(true);
    setError("");
    try {
      const response = await api<{ collection: Collection }>(`/v1/tenants/${tenantId}/collections/${collectionEditing.id}`, {
        method: "PATCH",
        body: JSON.stringify(collectionEdit),
      });
      setCollectionEditing(null);
      if (selected?.id === response.collection.id) setSelected(response.collection);
      setNotice("Collection updated.");
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to update collection."));
    } finally {
      setBusy(false);
    }
  }

  async function removeCollection(collection: Collection) {
    if (!confirm(`Delete ${collection.name}? Its items will be hidden, and its channel and AI agent links removed. Historical data is retained.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/tenants/${tenantId}/collections/${collection.id}`, { method: "DELETE" });
      if (selected?.id === collection.id) { setSelected(null); setFields([]); setItems([]); }
      setNotice(`${collection.name} deleted.`);
      await loadCollections();
      onChanged?.();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to delete collection."));
    } finally {
      setBusy(false);
    }
  }

  function startAdd() {
    setEditing(null);
    setValues(Object.fromEntries(fields.map((field) => [field.key, seedFor(field)])));
    setFormOpen(true);
    setError("");
  }

  function startEdit(item: Item) {
    setEditing(item);
    setValues(Object.fromEntries(fields.map((field) => [field.key, item.data_jsonb[field.key] ?? seedFor(field)])));
    setFormOpen(true);
    setError("");
  }

  function setValue(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function normalizedData() {
    const data: Record<string, unknown> = {};
    for (const field of fields) {
      let value = values[field.key];
      if (field.required && ((Array.isArray(value) && !value.length) || value === "" || value === null || value === undefined)) throw new Error(`${field.label} is required.`);
      if ((field.type === "integer" || field.type === "decimal") && value !== "" && value !== null && value !== undefined) value = Number(value);
      if (field.type === "json" && typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          throw new Error(`${field.label} must contain valid JSON.`);
        }
      }
      data[field.key] = value;
    }
    return data;
  }

  async function saveItem(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = normalizedData();
      const title = String(data.name ?? data.title ?? editing?.title ?? "").trim();
      const result = editing
        ? await api<{ item: Item }>(`/v1/tenants/${tenantId}/collections/${selected.id}/items/${editing.id}`, { method: "PATCH", body: JSON.stringify({ title: title || null, data, schemaVersion: selected.schema_version }) })
        : await api<{ item: Item }>(`/v1/tenants/${tenantId}/collections/${selected.id}/items`, { method: "POST", body: JSON.stringify({ ...(title ? { title } : {}), data, schemaVersion: selected.schema_version }) });
      const selectedMedia = [...new Set(fields.filter((field) => field.type === "media").flatMap((field) => mediaIds(data[field.key])))];
      if (fields.some((field) => field.type === "media")) await api(`/v1/tenants/${tenantId}/collections/${selected.id}/items/${result.item.id}/media`, { method: "PUT", body: JSON.stringify({ mediaAssetIds: selectedMedia }) });
      setFormOpen(false);
      setEditing(null);
      setNotice(editing ? "Item updated." : "Item added.");
      await loadItems(selected);
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to save item."));
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item: Item) {
    if (!selected || !confirm(`Delete ${item.title || "this item"}?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/tenants/${tenantId}/collections/${selected.id}/items/${item.id}`, { method: "DELETE" });
      setNotice("Item deleted.");
      await loadItems(selected);
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Delete failed."));
    } finally {
      setBusy(false);
    }
  }

  async function addField(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const choices = [...new Set(fieldDraft.choices.split("\n").map((choice) => choice.trim()).filter(Boolean))];
      if ((fieldDraft.type === "single_select" || fieldDraft.type === "multi_select") && !choices.length) throw new Error("Add at least one choice for this select field.");
      if (fieldDraft.type === "relation" && !fieldDraft.targetCollectionId) throw new Error("Choose the related collection.");
      const field = {
        key: fieldDraft.key, label: fieldDraft.label, type: fieldDraft.type,
        required: fieldDraft.required, searchable: fieldDraft.searchable,
        filterable: fieldDraft.filterable, sortable: fieldDraft.sortable, aiVisible: fieldDraft.aiVisible,
      };
      await api(`/v1/tenants/${tenantId}/collections/${selected.id}/fields`, {
        method: "POST",
        body: JSON.stringify({
          field: {
            ...field,
            uniqueWithinCollection: false,
            defaultValue: undefined,
            validation: {},
            options: fieldDraft.type === "relation" ? { targetCollectionId: fieldDraft.targetCollectionId } : fieldDraft.type === "single_select" || fieldDraft.type === "multi_select" ? { values: choices } : {},
            displayOrder: fields.length,
          },
          expectedSchemaVersion: selected.schema_version,
        }),
      });
      setFieldOpen(false);
      setFieldDraft({ key: "", label: "", type: "text", choices: "", targetCollectionId: "", required: false, searchable: true, filterable: false, sortable: false, aiVisible: true });
      setNotice("Field added. New items now use it automatically.");
      await openCollection(selected);
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to add field."));
    } finally {
      setBusy(false);
    }
  }

  function startEditField(field: FieldRow) {
    setFieldEditing(field);
    setFieldDraft((current) => ({
      ...current,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      searchable: Boolean(field.searchable),
      filterable: Boolean(field.filterable),
      sortable: Boolean(field.sortable),
      aiVisible: field.ai_visible !== false,
    }));
    setError("");
  }

  async function saveField(event: FormEvent) {
    event.preventDefault();
    if (!selected || !fieldEditing) return;
    setBusy(true);
    setError("");
    try {
      await api(`/v1/tenants/${tenantId}/collections/${selected.id}/fields/${fieldEditing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          field: {
            label: fieldDraft.label,
            required: fieldDraft.required,
            searchable: fieldDraft.searchable,
            filterable: fieldDraft.filterable,
            sortable: fieldDraft.sortable,
            aiVisible: fieldDraft.aiVisible,
          },
          expectedSchemaVersion: selected.schema_version,
        }),
      });
      setFieldEditing(null);
      setNotice("Field updated.");
      await openCollection(selected);
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to update field."));
    } finally {
      setBusy(false);
    }
  }

  async function updateChannelLinks(channelId: string, checked: boolean) {
    if (!selected) return;
    const next = checked ? [...new Set([...linkedChannelIds, channelId])] : linkedChannelIds.filter((id) => id !== channelId);
    setBusy(true);
    setError("");
    try {
      await api(`/v1/tenants/${tenantId}/collections/${selected.id}/channels`, { method: "PUT", body: JSON.stringify({ channelIds: next }) });
      setLinkedChannelIds(next);
      setNotice("Channel data links updated.");
      await loadCollections();
    } catch (reason) {
      setError(errorMessage(reason, "Unable to update channel links."));
    } finally {
      setBusy(false);
    }
  }

  async function importItems(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    let rows: unknown;
    try {
      rows = JSON.parse(importText);
    } catch {
      setError("Import must be a valid JSON array.");
      return;
    }
    if (!Array.isArray(rows)) {
      setError("Import must be a JSON array.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ job: { id: string } }>(`/v1/tenants/${tenantId}/collections/${selected.id}/import`, {
        method: "POST",
        body: JSON.stringify({
          items: rows.map((row) => {
            if (typeof row === "object" && row !== null && "data" in row) return row;
            const source = typeof row === "object" && row !== null ? row as Record<string, unknown> : {};
            return { title: String(source.name ?? source.title ?? ""), data: row };
          }),
        }),
      });
      setImportOpen(false);
      setNotice(`Import queued (${result.job.id.slice(0, 8)}). Refresh the collection shortly to see imported items.`);
    } catch (reason) {
      setError(errorMessage(reason, "Unable to queue import."));
    } finally {
      setBusy(false);
    }
  }

  async function exportItems() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ job: { id: string } }>(`/v1/tenants/${tenantId}/collections/${selected.id}/export`, { method: "POST", body: "{}" });
      setNotice(`Export queued (${result.job.id.slice(0, 8)}). The private file will appear in Media when ready.`);
    } catch (reason) {
      setError(errorMessage(reason, "Unable to queue export."));
    } finally {
      setBusy(false);
    }
  }

  async function uploadMedia(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !selected) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("visibility", "private");
      const response = await api<{ asset: Asset }>(`/v1/tenants/${tenantId}/media`, { method: "POST", headers: { "x-business-id": selected.business_id }, body });
      setAssets((current) => [response.asset, ...current.filter((asset) => asset.id !== response.asset.id)]);
      setNotice("Image uploaded. Select it in this item form.");
    } catch (reason) {
      setError(errorMessage(reason, "Media upload failed. Open Media library to set up storage."));
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }

  const summaryFields = useMemo(() => fields.filter((field) => field.type !== "media").slice(0, 4), [fields]);

  function renderControl(field: FieldRow) {
    const value = values[field.key];
    const options = Array.isArray(field.options_json?.values) ? field.options_json.values.map(String) : [];
    if (field.type === "long_text") return <textarea style={{ ...control, minHeight: 110, resize: "vertical" }} required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)} />;
    if (field.type === "boolean") return <label style={{ display: "flex", gap: 9, alignItems: "center", padding: "10px 0" }}><input type="checkbox" checked={Boolean(value)} onChange={(event) => setValue(field.key, event.target.checked)} /><span>Enabled / Yes</span></label>;
    if (field.type === "integer" || field.type === "decimal" || field.type === "currency") return <input style={control} type="number" step={field.type === "integer" ? 1 : "any"} required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)} />;
    if (field.type === "date") return <input style={control} type="date" required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)} />;
    if (field.type === "datetime") return <input style={control} type="datetime-local" required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)} />;
    if (field.type === "single_select") return <select style={control} required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)}><option value="">Select…</option>{options.map((option) => <option key={option}>{option}</option>)}</select>;
    if (field.type === "multi_select") return <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{options.map((option) => <label key={option} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "7px 10px", display: "flex", gap: 7 }}><input type="checkbox" checked={Array.isArray(value) && value.includes(option)} onChange={(event) => setValue(field.key, event.target.checked ? [...(Array.isArray(value) ? value : []), option] : (Array.isArray(value) ? value : []).filter((entry) => entry !== option))} />{option}</label>)}{!options.length && <span style={{ color: "#667085", fontSize: 13 }}>No choices configured for this field.</span>}</div>;
    if (field.type === "relation") return <select style={control} required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)}><option value="">Select related item…</option>{(relatedItems[field.key] ?? []).map((item) => <option key={item.id} value={item.id}>{item.title || item.id.slice(0, 8)}</option>)}</select>;
    if (field.type === "media") return <div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(115px,1fr))", gap: 8 }}>{assets.filter((asset) => asset.mime_type?.startsWith("image/")).map((asset) => { const checked = mediaIds(value).includes(asset.id); return <label key={asset.id} style={{ border: checked ? "2px solid #4f46e5" : "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden", cursor: "pointer", background: checked ? "#eef2ff" : "#fff" }}><div style={{ height: 82, background: "#f3f4f6" }}><Image src={asset.public_url || `${API_URL}/v1/tenants/${tenantId}/media/${asset.id}/content`} alt={asset.original_name || "Image"} width={150} height={82} sizes="150px" unoptimized style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div><div style={{ padding: 7, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><input type="checkbox" checked={checked} onChange={(event) => setValue(field.key, event.target.checked ? [...mediaIds(value), asset.id] : mediaIds(value).filter((id) => id !== asset.id))} /> {asset.original_name || "Image"}</div></label>; })}</div><div style={{ marginTop: 9, display: "flex", gap: 10, alignItems: "center" }}><label style={{ ...button, padding: "7px 10px", background: "#eef2ff", color: "#4338ca", display: "inline-flex" }}>+ Upload image<input type="file" accept="image/*" onChange={uploadMedia} style={{ display: "none" }} /></label>{!embedded && <Link href="/media-library" style={{ fontSize: 13, color: "#4f46e5", fontWeight: 700 }}>Open Media library</Link>}</div></div>;
    if (field.type === "json") return <textarea style={{ ...control, minHeight: 90, fontFamily: "ui-monospace,monospace" }} value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)} onChange={(event) => setValue(field.key, event.target.value)} />;
    return <input style={control} type={field.type === "email" ? "email" : field.type === "url" ? "url" : field.type === "phone" ? "tel" : "text"} required={field.required} value={String(value ?? "")} onChange={(event) => setValue(field.key, event.target.value)} />;
  }

  const content = <>
    {!embedded && <>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 18, alignItems: "flex-start", marginBottom: 22 }}><div><div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".12em", color: "#6b7280", fontWeight: 800 }}>Customer Panel</div><h1 style={{ margin: "5px 0 6px", fontSize: 30 }}>Data / Catalogs</h1><p style={{ margin: 0, color: "#667085" }}>Create products, services and custom business data using normal form fields—raw JSON is never required for items.</p></div><div style={{ display: "flex", gap: 12 }}><Link href="/media-library" style={{ color: "#4f46e5", fontWeight: 750, textDecoration: "none" }}>Media library</Link><Link href="/" style={{ color: "#4f46e5", fontWeight: 750, textDecoration: "none" }}>← Dashboard</Link></div></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}><label style={{ display: "grid", gap: 6, color: "#667085", fontSize: 13 }}>Workspace<select style={control} value={tenantId} onChange={(event) => setSelectedTenantId(event.target.value)}>{memberships.map((membership) => <option key={membership.tenant_id} value={membership.tenant_id}>{membership.tenant_name} · {membership.role}</option>)}</select></label><label style={{ display: "grid", gap: 6, color: "#667085", fontSize: 13 }}>Business<select style={control} value={businessId} onChange={(event) => setSelectedBusinessId(event.target.value)}>{businesses.map((business) => <option key={business.id} value={business.id}>{business.name}</option>)}</select></label></div>
    </>}
    {error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}
    {notice && <div role="status" style={{ ...card, borderColor: "#a7f3d0", background: "#ecfdf5", color: "#047857", marginBottom: 14 }}>{notice}</div>}
    {!businessId && <div style={{ ...card, color: "#92400e", background: "#fffbeb", borderColor: "#fde68a" }}>Create or select a business before managing its catalog.</div>}
    {!selected && businessId && <section style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 16 }}><div><h2 style={{ margin: 0 }}>Collections</h2><p style={{ margin: "5px 0 0", color: "#667085" }}>Each collection has its own schema, channel links and item form.</p></div><button disabled={busy} onClick={() => setCollectionOpen(true)} style={{ ...button, background: "#4f46e5", color: "#fff" }}>+ New collection</button></div>
      <div className="catalog-collection-grid">{collections.map((collection) => <article className="catalog-collection-card" key={collection.id}>
        <button disabled={busy} onClick={() => void openCollection(collection)} className="catalog-collection-open">
          <CollectionPreview collection={collection} tenantId={tenantId} />
          <div className="catalog-collection-card-body">
            <div className="catalog-collection-title-row"><strong>{collection.name}</strong><span>{collection.purpose || "Custom"}</span></div>
            <div className="catalog-collection-stats">
              <span><b>{collection.item_count ?? 0}</b> items</span>
              <span><b>{collection.field_count ?? 0}</b> fields</span>
              <span><b>{collection.channel_count ?? 0}</b> channels</span>
            </div>
          </div>
        </button>
        <div className="catalog-collection-actions"><button disabled={busy} onClick={() => startEditCollection(collection)} style={{ ...button, background: "#eef2ff", color: "#4338ca" }}>Edit</button><button disabled={busy} onClick={() => void removeCollection(collection)} style={{ ...button, background: "#fff1f2", color: "#be123c" }}>Delete</button><button disabled={busy} onClick={() => void openCollection(collection)} style={{ ...button, background: "#4f46e5", color: "#fff", marginLeft: "auto" }}>Open</button></div>
      </article>)}</div>
      {!collections.length && <div style={{ padding: 30, textAlign: "center", color: "#667085" }}>No collections yet. Create one to add products, services or custom business data.</div>}
    </section>}
    {selected && <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 12 }}><div><button onClick={() => setSelected(null)} style={{ ...button, background: "transparent", color: "#4f46e5", paddingLeft: 0 }}>← All collections</button><h2 style={{ margin: "2px 0 0" }}>{selected.name}</h2><div style={{ fontSize: 13, color: "#667085", marginTop: 4 }}>{selected.purpose} · schema v{selected.schema_version} · {fields.length} fields</div></div><div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 }}><button disabled={busy} onClick={() => setFieldOpen(true)} style={{ ...button, background: "#eef2ff", color: "#4338ca" }}>+ Field</button><button disabled={busy} onClick={() => setImportOpen(true)} style={{ ...button, background: "#eef2ff", color: "#4338ca" }}>Import</button><button disabled={busy} onClick={() => void exportItems()} style={{ ...button, background: "#eef2ff", color: "#4338ca" }}>Export</button><button disabled={busy} onClick={startAdd} style={{ ...button, background: "#4f46e5", color: "#fff" }}>+ Add item</button></div></div>
      <section style={{ ...card, marginBottom: 14 }}><h3 style={{ marginTop: 0 }}>Schema</h3><div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>{fields.map((field) => <span key={field.id} style={{ display: "inline-flex", gap: 8, alignItems: "center", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 999, padding: "7px 10px", fontSize: 12 }}><span><b>{field.label}</b> · {field.type}{field.required ? " · required" : ""}</span><button disabled={busy} onClick={() => startEditField(field)} style={{ border: 0, background: "transparent", color: "#4338ca", fontWeight: 700, cursor: "pointer" }}>Edit</button></span>)}</div></section>
      <section style={{ ...card, marginBottom: 14 }}><h3 style={{ marginTop: 0 }}>Channel data links</h3><p style={{ marginTop: 0, color: "#667085", fontSize: 13 }}>Only selected business channels can use this collection in automation.</p><div className="catalog-channel-links">{channels.map((channel) => <label key={channel.id} className="catalog-channel-link"><input type="checkbox" disabled={busy} checked={linkedChannelIds.includes(channel.id)} onChange={(event) => void updateChannelLinks(channel.id, event.target.checked)} /><span>{channel.name} · {channel.platform}</span></label>)}{!channels.length && <span style={{ color: "#667085", fontSize: 13 }}>No channels connected to this business.</span>}</div></section>
      <section style={card}>
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <input
            style={{ ...control, maxWidth: 440 }}
            placeholder="Search items…"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void loadItems(selected); }}
          />
          <button onClick={() => void loadItems(selected)} style={{ ...button, background: "#eef2ff", color: "#4338ca" }}>Search</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #e5e7eb" }}>
                <th style={{ textAlign: "left", padding: 10, width: 112 }}>Image</th>
                <th style={{ textAlign: "left", padding: 10 }}>Item</th>
                {summaryFields.map((field) => <th key={field.id} style={{ textAlign: "left", padding: 10 }}>{field.label}</th>)}
                <th style={{ textAlign: "left", padding: 10 }}>Status</th>
                <th style={{ padding: 10 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => <tr key={item.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                <td style={{ padding: "8px 10px", width: 112 }}>
                  <CatalogItemMedia item={item} tenantId={tenantId} />
                </td>
                <td style={{ padding: 10 }}>
                  <strong>{item.title || "Untitled"}</strong>
                  <div style={{ fontSize: 11, color: "#98a2b3", marginTop: 3 }}>Updated {new Date(item.updated_at).toLocaleString()}</div>
                </td>
                {summaryFields.map((field) => <td key={field.id} style={{ padding: 10, maxWidth: 230, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatItemValue(item.data_jsonb[field.key])}</td>)}
                <td style={{ padding: 10 }}>{item.status}</td>
                <td style={{ padding: 10 }}>
                  <div style={{ display: "flex", gap: 7, justifyContent: "flex-end" }}>
                    <button onClick={() => startEdit(item)} style={{ ...button, padding: "7px 10px", background: "#eef2ff", color: "#4338ca" }}>Edit</button>
                    <button onClick={() => void removeItem(item)} style={{ ...button, padding: "7px 10px", background: "#fff1f2", color: "#be123c" }}>Delete</button>
                  </div>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
        {!items.length && <div style={{ padding: 40, textAlign: "center", color: "#667085" }}>No items yet. Click <b>+ Add item</b> and fill the normal form fields.</div>}
      </section>
    </>}
    {collectionEditing && <Modal onClose={() => !busy && setCollectionEditing(null)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><h2 style={{ margin: 0 }}>Edit collection</h2><button onClick={() => setCollectionEditing(null)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>
      {error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}
      <form onSubmit={saveCollection} style={{ display: "grid", gap: 16 }}>
        <Field label="Collection name" required><input style={control} required value={collectionEdit.name} onChange={(event) => setCollectionEdit((current) => ({ ...current, name: event.target.value }))} /></Field>
        <Field label="Purpose"><input style={control} value={collectionEdit.purpose} onChange={(event) => setCollectionEdit((current) => ({ ...current, purpose: event.target.value }))} /></Field>
        <label style={{ display: "flex", gap: 9, alignItems: "center" }}><input type="checkbox" checked={collectionEdit.isTransactionalSource} onChange={(event) => setCollectionEdit((current) => ({ ...current, isTransactionalSource: event.target.checked }))} /> Transactional source</label>
        <small style={{ color: "#667085" }}>The collection key stays unchanged so existing integrations keep working.</small>
        <button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Saving…" : "Save collection"}</button>
      </form>
    </Modal>}
    {fieldEditing && selected && <Modal onClose={() => !busy && setFieldEditing(null)}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><h2 style={{ margin: 0 }}>Edit field</h2><button onClick={() => setFieldEditing(null)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>
      {error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}
      <form onSubmit={saveField} style={{ display: "grid", gap: 16 }}>
        <Field label="Field key"><input style={control} value={fieldEditing.key} disabled /></Field>
        <Field label="Type"><input style={control} value={fieldEditing.type} disabled /></Field>
        <Field label="Label" required><input style={control} required value={fieldDraft.label} onChange={(event) => setFieldDraft((current) => ({ ...current, label: event.target.value }))} /></Field>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><label><input type="checkbox" checked={fieldDraft.required} onChange={(event) => setFieldDraft((current) => ({ ...current, required: event.target.checked }))} /> Required</label><label><input type="checkbox" checked={fieldDraft.searchable} onChange={(event) => setFieldDraft((current) => ({ ...current, searchable: event.target.checked }))} /> Searchable</label><label><input type="checkbox" checked={fieldDraft.filterable} onChange={(event) => setFieldDraft((current) => ({ ...current, filterable: event.target.checked }))} /> Filterable</label><label><input type="checkbox" checked={fieldDraft.sortable} onChange={(event) => setFieldDraft((current) => ({ ...current, sortable: event.target.checked }))} /> Sortable</label><label><input type="checkbox" checked={fieldDraft.aiVisible} onChange={(event) => setFieldDraft((current) => ({ ...current, aiVisible: event.target.checked }))} /> AI visible</label></div>
        <small style={{ color: "#667085" }}>Field key and type cannot be changed here because existing items may rely on them.</small>
        <button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Saving…" : "Save field"}</button>
      </form>
    </Modal>}
    {collectionOpen && <Modal onClose={() => !busy && setCollectionOpen(false)}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><div><h2 style={{ margin: 0 }}>Create collection</h2><p style={{ color: "#667085", margin: "5px 0 0" }}>Start with a ready-made schema or a blank custom collection.</p></div><button onClick={() => setCollectionOpen(false)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>{error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}<form onSubmit={createCollection} style={{ display: "grid", gap: 16 }}><Field label="Collection name" required><input style={control} required value={collectionDraft.name} onChange={(event) => setCollectionDraft((current) => ({ ...current, name: event.target.value }))} /></Field><Field label="Starting template"><select style={control} value={collectionDraft.template} onChange={(event) => setCollectionDraft((current) => ({ ...current, template: event.target.value as CollectionDraft["template"] }))}><option value="product">Products</option><option value="service">Services</option><option value="property">Properties</option><option value="menu">Menu</option><option value="package">Packages</option><option value="blank">Blank custom collection</option></select></Field><button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Creating…" : "Create collection"}</button></form></Modal>}
    {formOpen && selected && <Modal onClose={() => !busy && setFormOpen(false)}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><div><h2 style={{ margin: 0 }}>{editing ? "Edit item" : "Add item"}</h2><div style={{ color: "#667085", fontSize: 13, marginTop: 4 }}>{selected.name} · fields follow schema v{selected.schema_version}</div></div><button onClick={() => setFormOpen(false)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>{error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}<form onSubmit={saveItem} style={{ display: "grid", gap: 16 }}>{fields.map((field) => <Field key={field.id} label={field.label} required={field.required} hint={field.type === "media" ? "Select one or more reusable images. The first selected image becomes primary." : undefined}>{renderControl(field)}</Field>)}<button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Saving…" : editing ? "Save changes" : "Add item"}</button></form></Modal>}
    {fieldOpen && selected && <Modal onClose={() => !busy && setFieldOpen(false)}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><div><h2 style={{ margin: 0 }}>Add custom field</h2><p style={{ color: "#667085", margin: "5px 0 0" }}>It will appear in future Add Item forms after saving.</p></div><button onClick={() => setFieldOpen(false)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>{error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}<form onSubmit={addField} style={{ display: "grid", gap: 16 }}><div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}><Field label="Field key" required><input style={control} required pattern="[a-z][a-z0-9_]*" value={fieldDraft.key} onChange={(event) => setFieldDraft((current) => ({ ...current, key: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))} /></Field><Field label="Label" required><input style={control} required value={fieldDraft.label} onChange={(event) => setFieldDraft((current) => ({ ...current, label: event.target.value }))} /></Field></div><Field label="Type"><select style={control} value={fieldDraft.type} onChange={(event) => setFieldDraft((current) => ({ ...current, type: event.target.value }))}>{["text", "long_text", "integer", "decimal", "currency", "boolean", "date", "datetime", "email", "phone", "url", "single_select", "multi_select", "media", "relation", "json"].map((type) => <option key={type}>{type}</option>)}</select></Field>{(fieldDraft.type === "single_select" || fieldDraft.type === "multi_select") && <Field label="Choices" required hint="One choice per line."><textarea style={{ ...control, minHeight: 110 }} required value={fieldDraft.choices} onChange={(event) => setFieldDraft((current) => ({ ...current, choices: event.target.value }))} /></Field>}{fieldDraft.type === "relation" && <Field label="Related collection" required><select style={control} required value={fieldDraft.targetCollectionId} onChange={(event) => setFieldDraft((current) => ({ ...current, targetCollectionId: event.target.value }))}><option value="">Choose collection…</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}</select></Field>}<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}><label><input type="checkbox" checked={fieldDraft.required} onChange={(event) => setFieldDraft((current) => ({ ...current, required: event.target.checked }))} /> Required</label><label><input type="checkbox" checked={fieldDraft.searchable} onChange={(event) => setFieldDraft((current) => ({ ...current, searchable: event.target.checked }))} /> Searchable</label><label><input type="checkbox" checked={fieldDraft.filterable} onChange={(event) => setFieldDraft((current) => ({ ...current, filterable: event.target.checked }))} /> Filterable</label><label><input type="checkbox" checked={fieldDraft.sortable} onChange={(event) => setFieldDraft((current) => ({ ...current, sortable: event.target.checked }))} /> Sortable</label><label><input type="checkbox" checked={fieldDraft.aiVisible} onChange={(event) => setFieldDraft((current) => ({ ...current, aiVisible: event.target.checked }))} /> AI visible</label></div><button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Adding…" : "Add field"}</button></form></Modal>}
    {importOpen && selected && <Modal onClose={() => !busy && setImportOpen(false)}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}><div><h2 style={{ margin: 0 }}>Import items</h2><p style={{ color: "#667085", margin: "5px 0 0" }}>Use a JSON array for bulk import. Individual items always use the normal form.</p></div><button onClick={() => setImportOpen(false)} style={{ ...button, background: "transparent", fontSize: 22 }}>×</button></div>{error && <div role="alert" style={{ ...card, borderColor: "#fecaca", background: "#fff7f6", color: "#b42318", marginBottom: 14 }}>{error}</div>}<form onSubmit={importItems} style={{ display: "grid", gap: 16 }}><Field label="JSON array" hint='Use [{"title":"...","data":{...}}] or an array of plain item objects.'><textarea style={{ ...control, minHeight: 260, fontFamily: "ui-monospace,monospace" }} value={importText} onChange={(event) => setImportText(event.target.value)} /></Field><button disabled={busy} style={{ ...button, background: "#4f46e5", color: "#fff", fontSize: 15 }}>{busy ? "Queuing…" : "Queue import"}</button></form></Modal>}
  </>;

  if (embedded) return <div style={{ width: "100%" }}>{content}</div>;
  return <main style={{ minHeight: "100vh", background: "#f6f8fc", fontFamily: "Inter,system-ui,sans-serif", padding: "32px 24px" }}><div style={{ maxWidth: 1280, margin: "0 auto" }}>{content}</div></main>;
}
