"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { API_URL, ApiClientError, api, qs, signIn, signOut, signUp } from "../lib/api";
import CatalogsPage from "../app/catalogs/page";
import UsagePage from "../app/usage/page";
import AgentManager from "./AgentManager";
import { useConfirmAction } from "./ConfirmProvider";

type Membership = { tenant_id: string; tenant_name: string; tenant_slug: string; role: string; status: string };
type AuthState = { principal: any; memberships: Membership[] } | null;
type NavKey = "dashboard" | "businesses" | "data" | "conversations" | "orders" | "ai" | "training" | "knowledge" | "media" | "analytics" | "usage" | "team" | "settings";
type CatalogNavigationTarget = { collectionId: string; itemId?: string | null; businessId?: string | null };

const nav: Array<[NavKey, string, string]> = [
  ["dashboard", "Dashboard", "⌂"], ["businesses", "Businesses & Channels", "◫"], ["data", "Data / Catalogs", "▦"],
  ["conversations", "Conversations", "✦"], ["orders", "Business Actions", "✓"], ["ai", "AI Agents", "◆"], ["training", "Training", "↗"],
  ["knowledge", "Knowledge", "▤"], ["media", "Media", "▧"], ["analytics", "Analytics", "⌁"], ["usage", "Usage", "◴"], ["team", "Team", "♙"], ["settings", "Settings", "⚙"],
];

function cx(...parts: Array<string | false | null | undefined>) { return parts.filter(Boolean).join(" "); }
function fmt(n: unknown) { const value = Number(n || 0); return new Intl.NumberFormat().format(Number.isFinite(value) ? value : 0); }
function date(value: unknown) { if (!value) return "—"; const d = new Date(String(value)); return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(); }

function Card({ title, value, note }: { title: string; value: ReactNode; note?: string }) {
  return <div className="card"><div className="muted small">{title}</div><div className="metric">{value}</div>{note && <div className="muted tiny">{note}</div>}</div>;
}
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "neutral" | "brand" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
function SectionHeader({ title, description, action }: { title: ReactNode; description?: string; action?: ReactNode }) {
  return <div className="section-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>;
}
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const titleId=useId();const modalRef=useRef<HTMLDivElement>(null);const closeRef=useRef(onClose);
  useEffect(()=>{closeRef.current=onClose;},[onClose]);
  useEffect(()=>{const previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;const previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";modalRef.current?.focus();function onKeyDown(event:globalThis.KeyboardEvent){if(event.key==="Escape"){event.preventDefault();closeRef.current();return;}if(event.key!=="Tab"||!modalRef.current)return;const dialog=modalRef.current;const focusable=Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));if(!focusable.length){event.preventDefault();return;}const first=focusable[0];const last=focusable[focusable.length-1];if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}}document.addEventListener("keydown",onKeyDown);return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener("keydown",onKeyDown);if(previousFocus?.isConnected)previousFocus.focus();};},[]);
  return <div className="modal-backdrop" onMouseDown={onClose}><div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event)=>event.stopPropagation()}><div className="modal-title"><h3 id={titleId}>{title}</h3><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div>{children}</div></div>;
}
function Drawer({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
 const titleId=useId();
 const drawerRef=useRef<HTMLElement>(null);const closeRef=useRef(onClose);
 useEffect(()=>{closeRef.current=onClose;},[onClose]);
 useEffect(()=>{const previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;const previousOverflow=document.body.style.overflow;document.body.style.overflow="hidden";drawerRef.current?.focus();function onKeyDown(event:globalThis.KeyboardEvent){if(event.key==="Escape"){event.preventDefault();closeRef.current();return;}if(event.key!=="Tab"||!drawerRef.current)return;const dialog=drawerRef.current;const focusable=Array.from(dialog.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));if(!focusable.length){event.preventDefault();return;}const first=focusable[0];const last=focusable[focusable.length-1];if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}}document.addEventListener("keydown",onKeyDown);return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener("keydown",onKeyDown);if(previousFocus?.isConnected)previousFocus.focus();};},[]);
 return <div className="drawer-backdrop" onMouseDown={onClose}><aside ref={drawerRef} className="side-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={event=>event.stopPropagation()} tabIndex={-1}><header className="drawer-header"><div><div className="eyebrow">Business workspace</div><h2 id={titleId}>{title}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close channel drawer">×</button></header><div className="drawer-body">{children}</div></aside></div>;
}

function AuthView({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"signin"|"signup">("signin");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [noticeTone, setNoticeTone] = useState<"success"|"warn">("success");
  const [form, setForm] = useState({ email:"", password:"", name:"", organizationName:"" });
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setNotice(""); setNoticeTone("success");
    try {
      if (mode === "signin") {
        const result = await signIn(form.email, form.password);
        if (result.mfaRequired || result.mfaSetupRequired) throw new Error("Customer sign-in could not be established. Use a customer account in the Customer Panel.");
      } else {
        await signUp(form); setNotice("Account created. Check your email to verify the address.");
      }
      onAuthenticated();
    } catch (err) { setError(err instanceof Error ? err.message : "Request failed"); }
    finally { setBusy(false); }
  }
  async function requestReset() {
    if (!form.email) { setNotice(""); return setError("Enter your email first."); }
    setError(""); setNotice(""); setNoticeTone("success");
    try { await api("/v1/auth/request-password-reset", { method:"POST", body:JSON.stringify({email:form.email,realm:"customer"}) }); setNotice("If the account exists, a password-reset email has been sent."); } catch (err) { setNotice(""); setError(err instanceof Error ? err.message : "Request failed"); }
  }
  return (
    <main className="auth-shell">
      <section className="auth-card auth-login-card" aria-labelledby="customer-auth-title">
        <div className="auth-card-brand auth-brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Automation SaaS</strong>
            <span>Customer Panel</span>
          </div>
        </div>
        <div className="auth-heading">
          <h1 id="customer-auth-title">{mode === "signin" ? "Welcome back" : "Create your account"}</h1>
          <p>{mode === "signin" ? "Sign in to continue to your workspace." : "Create a customer workspace to get started."}</p>
        </div>
        <div className="tabs" role="tablist" aria-label="Authentication mode">
          <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Create account</button>
        </div>
        <form onSubmit={submit} className="stack">
          {mode === "signup" && <>
            <Field label="Your name"><input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Organization / account name"><input required value={form.organizationName} onChange={e => setForm({ ...form, organizationName: e.target.value })} /></Field>
          </>}
          <Field label="Email"><input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password" hint={mode === "signup" ? "At least 10 characters with letters and numbers" : undefined}><input type="password" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></Field>
          {error && <div className="alert error">{error}</div>}
          {notice && <div className={`alert ${noticeTone}`}>{notice}</div>}
          <button className="button primary" disabled={busy}>{busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}</button>
          {mode === "signin" && <button type="button" className="link-button" onClick={requestReset}>Forgot password?</button>}
        </form>
      </section>
    </main>
  );
}

export default function CustomerApp() {
  const router=useRouter();
  const [auth,setAuth]=useState<AuthState>(null); const [loading,setLoading]=useState(true); const [navKey,setNavKey]=useState<NavKey>("dashboard");
  const [tenantId,setTenantId]=useState(""); const [businessId,setBusinessId]=useState(""); const [businesses,setBusinesses]=useState<any[]>([]); const [refresh,setRefresh]=useState(0);
  const [error,setError]=useState("");
  const [logoutBusy,setLogoutBusy]=useState(false); const [logoutError,setLogoutError]=useState("");
  const [isCompact,setIsCompact]=useState(false);const [mobileNavOpen,setMobileNavOpen]=useState(false);const mobileMenuButton=useRef<HTMLButtonElement>(null);
  const [catalogFocus,setCatalogFocus]=useState<{collectionId:string;itemId:string|null}|null>(null);
  const loadAuth=useCallback(async()=>{setLoading(true);try{const data=await api<AuthState>("/v1/auth/me");setAuth(data);const first=data?.memberships?.[0]?.tenant_id||"";setTenantId(v=>v||first);}catch{setAuth(null);}finally{setLoading(false);}},[]);
  useEffect(()=>{void loadAuth();},[loadAuth]);
  useEffect(()=>{const query=window.matchMedia("(max-width: 820px)");const update=()=>setIsCompact(query.matches);update();query.addEventListener("change",update);return()=>query.removeEventListener("change",update);},[]);
  useEffect(()=>{
    if(!isCompact||!mobileNavOpen)return;
    const sidebar=document.getElementById("customer-navigation");
    const menuButton=mobileMenuButton.current;
    const previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const focusFrame=window.requestAnimationFrame(()=>sidebar?.querySelector<HTMLElement>('button:not([disabled])')?.focus());
    function onKeyDown(event:KeyboardEvent){
      if(event.key==="Escape"){event.preventDefault();setMobileNavOpen(false);return;}
      if(event.key!=="Tab"||!sidebar)return;
      const focusable=Array.from(sidebar.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])'));
      if(!focusable.length){event.preventDefault();return;}
      const first=focusable[0],last=focusable[focusable.length-1];
      if(event.shiftKey&&(document.activeElement===first||!sidebar.contains(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!sidebar.contains(document.activeElement))){event.preventDefault();first.focus();}
    }
    document.addEventListener("keydown",onKeyDown);
    return()=>{window.cancelAnimationFrame(focusFrame);document.body.style.overflow=previousOverflow;document.removeEventListener("keydown",onKeyDown);if(previousFocus?.isConnected)menuButton?.focus();};
  },[isCompact,mobileNavOpen]);
  useEffect(()=>{if(!auth)return;const params=new URLSearchParams(window.location.search);const requestedTenant=params.get("tenantId");const requestedBusiness=params.get("businessId");const requestedCollection=params.get("collectionId");const requestedItem=params.get("itemId");const focusFrame=window.requestAnimationFrame(()=>{if(requestedTenant&&auth.memberships.some(m=>m.tenant_id===requestedTenant))setTenantId(requestedTenant);if(requestedBusiness)setBusinessId(requestedBusiness);if(params.get("view")==="data"){setNavKey("data");if(requestedCollection)setCatalogFocus({collectionId:requestedCollection,itemId:requestedItem});}else if(params.get("view")==="businesses"||params.has("metaConnection")||params.has("metaError"))setNavKey("businesses");else if(params.get("view")==="agents"||params.get("view")==="ai")setNavKey("ai");});return()=>window.cancelAnimationFrame(focusFrame);},[auth]);
  useEffect(()=>{if(!tenantId)return;let active=true;api<any>(`/v1/tenants/${tenantId}/businesses`).then(d=>{if(!active)return;setBusinesses(d.businesses||[]);setBusinessId(v=>v&&d.businesses?.some((b:any)=>b.id===v)?v:(d.businesses?.[0]?.id||""));}).catch(e=>{if(active)setError(e.message)});return()=>{active=false};},[tenantId,refresh]);
  if(loading) return <div className="screen-center"><div className="spinner"/>Loading workspace…</div>;
  if(!auth) return <AuthView onAuthenticated={loadAuth}/>;
  const membership=auth.memberships.find(m=>m.tenant_id===tenantId); const currentBusiness=businesses.find(b=>b.id===businessId);
  async function logout(){
    if(logoutBusy)return;
    setLogoutBusy(true);setLogoutError("");
    try{
      await signOut();
      setAuth(null);setTenantId("");setBusinessId("");setBusinesses([]);setNavKey("dashboard");setError("");
    }catch(err){
      setLogoutError(err instanceof ApiClientError&&err.code==="CSRF_INVALID"
        ? "Session check failed. Refresh the page, then try signing out again."
        : "Sign out failed. Please try again.");
    }finally{setLogoutBusy(false);}
  }
  function openCatalogTarget(target:CatalogNavigationTarget){
    const targetBusinessId=target.businessId||businessId;
    const params=new URLSearchParams({view:"data",tenantId});
    if(targetBusinessId)params.set("businessId",targetBusinessId);
    params.set("collectionId",target.collectionId);
    if(target.itemId)params.set("itemId",target.itemId);
    setBusinessId(targetBusinessId);
    setCatalogFocus({collectionId:target.collectionId,itemId:target.itemId??null});
    setNavKey("data");
    setMobileNavOpen(false);
    router.push(`/?${params.toString()}`);
  }
 return <div className="app-shell">
   <aside id="customer-navigation" className={cx("sidebar",mobileNavOpen&&"open")} aria-label="Customer navigation" aria-hidden={isCompact&&!mobileNavOpen} inert={isCompact&&!mobileNavOpen}>
     <div className="sidebar-brand"><div className="brand-mark smallmark">A</div><div><strong>Automation</strong><span>Customer Panel</span></div></div>
     <nav>{nav.map(([key,label,icon])=><button key={key} className={navKey===key?"active":""} onClick={()=>{setNavKey(key);setMobileNavOpen(false);}}><span aria-hidden="true">{icon}</span>{label}</button>)}</nav>
     <div className="sidebar-bottom"><div className="user-chip"><div className="avatar">{(auth.principal?.name||auth.principal?.email||"U")[0].toUpperCase()}</div><div><strong>{auth.principal?.name||"Account"}</strong><span>{auth.principal?.email}</span></div></div><button type="button" className="sidebar-logout" onClick={logout} disabled={logoutBusy}>{logoutBusy?"Signing out…":"Sign out"}</button>{logoutError&&<div className="sidebar-logout-error" role="alert">{logoutError}</div>}</div>
   </aside>
   <button type="button" className={cx("sidebar-scrim",mobileNavOpen&&"visible")} onClick={()=>setMobileNavOpen(false)} aria-label="Close navigation" tabIndex={mobileNavOpen?0:-1}/>
   <main className="main" inert={isCompact&&mobileNavOpen} aria-hidden={isCompact&&mobileNavOpen}>
     <header className="topbar"><button ref={mobileMenuButton} type="button" className="mobile-menu-button" aria-label="Open navigation menu" aria-expanded={mobileNavOpen} aria-controls="customer-navigation" onClick={()=>setMobileNavOpen(value=>!value)}><span aria-hidden="true">☰</span></button><div className="topbar-title"><div className="eyebrow">{membership?.tenant_name||"Workspace"}</div><h1>{nav.find(([key])=>key===navKey)?.[1]}</h1></div><div className="selectors"><select aria-label="Workspace" value={tenantId} onChange={e=>setTenantId(e.target.value)}>{auth.memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenant_name} · {m.role}</option>)}</select><select aria-label="Business" value={businessId} onChange={e=>setBusinessId(e.target.value)}><option value="">All businesses</option>{businesses.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div></header>
     {error&&<div className="alert error content-alert">{error}<button onClick={()=>setError("")}>×</button></div>}
     <div className={cx("content",navKey==="businesses"&&"content-wide")}>
       {navKey==="dashboard"&&<Dashboard tenantId={tenantId} businessId={businessId}/>}
       {navKey==="businesses"&&<Businesses tenantId={tenantId} rows={businesses} selectedBusinessId={businessId} role={membership?.role} onChanged={()=>setRefresh(x=>x+1)}/>}
       {navKey==="data"&&<CatalogsPage embedded tenantId={tenantId} businessId={businessId} focusCollectionId={catalogFocus?.collectionId} focusItemId={catalogFocus?.itemId} onChanged={()=>setRefresh(x=>x+1)}/>}
       {navKey==="conversations"&&<Conversations key={`${tenantId}:${businessId}`} tenantId={tenantId} businessId={businessId}/>}
       {navKey==="orders"&&<BusinessActions tenantId={tenantId} businessId={businessId} onCatalogOpen={openCatalogTarget}/>}
       {navKey==="ai"&&<AgentManager key={`${tenantId}:${businessId}`} tenantId={tenantId} businessId={businessId} role={membership?.role}/>}
       {navKey==="training"&&<Training key={`${tenantId}:${businessId}`} tenantId={tenantId} businessId={businessId}/>}
       {navKey==="knowledge"&&<Knowledge tenantId={tenantId} businessId={businessId} role={membership?.role}/>}
       {navKey==="media"&&<Media tenantId={tenantId} businessId={businessId}/>}
       {navKey==="analytics"&&<Analytics tenantId={tenantId} businessId={businessId}/>}
       {navKey==="usage"&&<UsagePage embedded workspaceId={tenantId}/>}
       {navKey==="team"&&<Team tenantId={tenantId} role={membership?.role} userId={auth.principal?.userId||""}/>}
       {navKey==="settings"&&<Settings tenantId={tenantId} role={membership?.role} currentBusiness={currentBusiness} onChanged={()=>setRefresh(x=>x+1)}/>}
     </div>
   </main>
 </div>;
}

function Dashboard({tenantId,businessId}:{tenantId:string;businessId:string}){
  const [data,setData]=useState<any>(null); const [channels,setChannels]=useState<any[]>([]); const [loading,setLoading]=useState(true);
  useEffect(()=>{if(!tenantId)return;setLoading(true);Promise.all([api<any>(`/v1/tenants/${tenantId}/analytics/overview${qs({businessId})}`),api<any>(`/v1/tenants/${tenantId}/channels${qs({businessId})}`)]).then(([a,c])=>{setData(a);setChannels(c.channels||[]);}).finally(()=>setLoading(false));},[tenantId,businessId]);
  if(loading)return <Loading/>; const m=data?.metrics||{};
  return <><SectionHeader title="Business pulse" description="Transport activity, AI work and outcomes remain separate so you can understand real usage."/><div className="metric-grid"><Card title="Inbound messages" value={fmt(m.inbound_message?.quantity)}/><Card title="Outbound messages" value={fmt(m.outbound_message?.quantity)}/><Card title="AI calls" value={fmt(m.ai_call?.quantity)} note={`Est. cost ${Number(m.ai_call?.estimatedCost||0).toFixed(4)}`}/><Card title="Open conversations" value={fmt(data?.conversations?.open)}/><Card title="Orders" value={fmt(data?.outcomes?.orders)}/><Card title="Bookings / Leads" value={`${fmt(data?.outcomes?.bookings)} / ${fmt(data?.outcomes?.leads)}`}/></div><div className="two-col"><div className="panel"><h3>Connected channels</h3>{channels.length?channels.map(c=><div className="list-row" key={c.id}><div><strong>{c.name}</strong><span>{c.platform} · {c.external_account_id}</span></div><Badge tone={c.connection_status==="connected"&&c.active?"good":"warn"}>{c.active?c.connection_status:"paused"}</Badge></div>):<Empty>Connect a Facebook Page, Instagram account or WhatsApp number to begin.</Empty>}</div><div className="panel"><h3>Conversation status</h3><div className="mini-stats"><div><b>{fmt(data?.conversations?.ai)}</b><span>AI mode</span></div><div><b>{fmt(data?.conversations?.human)}</b><span>Human mode</span></div><div><b>{fmt(data?.conversations?.total)}</b><span>Total in range</span></div></div></div></div></>;
}

type BusinessRow = { id:string; name:string; business_type_hint?:string|null; timezone:string; currency:string; locale:string; status:string; channel_count?:number; collection_count?:number };
type ChannelRow = { id:string; business_id:string; name:string; platform:string; external_account_id:string; connection_status:string; active:boolean; linked_collections?:number; last_webhook_at?:string|null; last_delivery_at?:string|null; settings_json?:Record<string,unknown> };
type BusinessDraft = { name:string; businessTypeHint:string; timezone:string; currency:string; locale:string; status:"active"|"paused" };

function businessDraft(row?:BusinessRow):BusinessDraft {
 return {name:row?.name??"",businessTypeHint:row?.business_type_hint??"",timezone:row?.timezone??(Intl.DateTimeFormat().resolvedOptions().timeZone||"UTC"),currency:row?.currency??"BDT",locale:row?.locale??"bn",status:row?.status==="paused"?"paused":"active"};
}

function Businesses({tenantId,rows,selectedBusinessId,role,onChanged}:{tenantId:string;rows:BusinessRow[];selectedBusinessId:string;role?:string;onChanged:()=>void}){
 const confirmAction=useConfirmAction();
 const canManage=role==="OWNER"||role==="ADMIN";
 const [createOpen,setCreateOpen]=useState(false);const [editing,setEditing]=useState<BusinessRow|null>(null);const [channelBusiness,setChannelBusiness]=useState<BusinessRow|null>(null);const [draft,setDraft]=useState<BusinessDraft>(businessDraft());const [busy,setBusy]=useState("");const [error,setError]=useState("");const [notice,setNotice]=useState("");
 useEffect(()=>{setChannelBusiness(current=>current?rows.find(row=>row.id===current.id)??null:null);},[rows]);
 useEffect(()=>{if(typeof window==="undefined")return;const params=new URLSearchParams(window.location.search);if(!params.has("metaConnection")&&!params.has("metaError"))return;const target=rows.find(row=>row.id===(params.get("businessId")||selectedBusinessId));if(target)setChannelBusiness(target);},[rows,selectedBusinessId]);
 function startCreate(){setDraft(businessDraft());setCreateOpen(true);setEditing(null);setError("");setNotice("")}
 function startEdit(row:BusinessRow){setDraft(businessDraft(row));setEditing(row);setCreateOpen(false);setError("");setNotice("")}
 async function create(e:FormEvent){e.preventDefault();setBusy("create");setError("");try{await api(`/v1/tenants/${tenantId}/businesses`,{method:"POST",body:JSON.stringify({name:draft.name,businessTypeHint:draft.businessTypeHint||undefined,timezone:draft.timezone,currency:draft.currency,locale:draft.locale})});setCreateOpen(false);setDraft(businessDraft());setNotice("Business created.");onChanged()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to create business.")}finally{setBusy("")}}
 async function save(e:FormEvent){e.preventDefault();if(!editing)return;setBusy(editing.id);setError("");try{await api(`/v1/tenants/${tenantId}/businesses/${editing.id}`,{method:"PATCH",body:JSON.stringify(draft)});setEditing(null);setNotice("Business updated.");onChanged()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to update business.")}finally{setBusy("")}}
 async function remove(row:BusinessRow){if(!await confirmAction({title:`Delete ${row.name}?`,description:"Its channels will be disconnected and credentials removed; agents and collections will be archived. Historical audit and transaction records are retained."}))return;setBusy(row.id);setError("");try{await api(`/v1/tenants/${tenantId}/businesses/${row.id}`,{method:"DELETE"});if(editing?.id===row.id)setEditing(null);if(channelBusiness?.id===row.id)setChannelBusiness(null);setNotice(`${row.name} deleted.`);onChanged()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to delete business.")}finally{setBusy("")}}
 const form=(submit:(e:FormEvent)=>void,label:string)=><form className="stack" onSubmit={submit}><Field label="Business name"><input required value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></Field><Field label="Business type hint"><input placeholder="e.g. Fashion store, salon, real estate" value={draft.businessTypeHint} onChange={e=>setDraft({...draft,businessTypeHint:e.target.value})}/></Field><div className="form-grid"><Field label="Timezone"><input required value={draft.timezone} onChange={e=>setDraft({...draft,timezone:e.target.value})}/></Field><Field label="Currency"><input required maxLength={3} value={draft.currency} onChange={e=>setDraft({...draft,currency:e.target.value.toUpperCase()})}/></Field><Field label="Locale"><input required value={draft.locale} onChange={e=>setDraft({...draft,locale:e.target.value})}/></Field>{editing&&<Field label="Status"><select value={draft.status} onChange={e=>setDraft({...draft,status:e.target.value as BusinessDraft["status"]})}><option value="active">Active</option><option value="paused">Paused</option></select></Field>}</div><button className="button primary" disabled={Boolean(busy)}>{busy?"Saving…":label}</button></form>;
 return <div className="businesses-view"><SectionHeader title="Businesses" description="Manage business details and open channel management in a focused drawer." action={canManage?<button className="button primary" onClick={startCreate}>+ New business</button>:undefined}/>{error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}<div className="table-wrap businesses-table-wrap"><table className="businesses-table"><thead><tr><th>Business</th><th>Channels</th><th>Data</th><th>Region</th><th>Status</th><th>Actions</th></tr></thead><tbody>{rows.map(row=><tr key={row.id} className={row.id===selectedBusinessId?"selected-business":""}><td><button className="business-name-button" onClick={()=>setChannelBusiness(row)}>{row.name}</button><small>{row.business_type_hint||"Flexible business"}</small></td><td><button className="button ghost smallbtn" onClick={()=>setChannelBusiness(row)}>{row.channel_count||0} · Manage channels</button></td><td>{row.collection_count||0} collections</td><td><strong>{row.currency}</strong><small>{row.timezone} · {row.locale}</small></td><td><Badge tone={row.status==="active"?"good":"warn"}>{row.status}</Badge></td><td><div className="business-actions">{canManage&&<><button className="button ghost smallbtn" onClick={()=>startEdit(row)}>Edit</button><button className="button danger smallbtn" disabled={busy===row.id} onClick={()=>void remove(row)}>{busy===row.id?"Deleting…":"Delete"}</button></>}</div></td></tr>)}</tbody></table>{!rows.length&&<Empty>Create your first business to attach channels, data and agents.</Empty>}</div>{channelBusiness&&<Drawer title={`${channelBusiness.name} · Channels`} onClose={()=>setChannelBusiness(null)}><Channels tenantId={tenantId} businessId={channelBusiness.id} businessName={channelBusiness.name} role={role} embedded onChanged={onChanged}/></Drawer>}{createOpen&&<Modal title="Create business" onClose={()=>!busy&&setCreateOpen(false)}>{form(create,"Create business")}</Modal>}{editing&&<Modal title="Edit business" onClose={()=>!busy&&setEditing(null)}>{form(save,"Save changes")}</Modal>}</div>;
}

function Channels({tenantId,businessId,businessName,role,embedded=false,onChanged}:{tenantId:string;businessId:string;businessName?:string;role?:string;embedded?:boolean;onChanged?:()=>void}){
 const confirmAction=useConfirmAction();
 const canManage=role==="OWNER"||role==="ADMIN";
 const [rows,setRows]=useState<ChannelRow[]>([]);const [loading,setLoading]=useState(true);const [loadError,setLoadError]=useState("");const [open,setOpen]=useState(false);const [editing,setEditing]=useState<ChannelRow|null>(null);const [busy,setBusy]=useState("");const [discovery,setDiscovery]=useState<any>(null);const [diag,setDiag]=useState<any>(null);const [error,setError]=useState("");const [notice,setNotice]=useState("");
 const [form,setForm]=useState({name:"",externalAccountId:"",publicIdentifier:"",accessToken:"",whatsappBusinessAccountId:""});
 const [editForm,setEditForm]=useState({name:"",active:true,accessToken:"",appSecret:"",verifyToken:"",whatsappBusinessAccountId:""});
 const load=useCallback(async()=>{if(!tenantId||!businessId){setRows([]);setLoading(false);return;}setLoading(true);setLoadError("");try{const data=await api<{channels?:ChannelRow[]}>(`/v1/tenants/${tenantId}/channels${qs({businessId})}`);setRows((data.channels||[]).filter(row=>!row.settings_json?.deletedAt));}catch(reason){setRows([]);setLoadError(reason instanceof Error?reason.message:"Unable to load channels.");}finally{setLoading(false)}},[tenantId,businessId]);
 useEffect(()=>{void load();},[load]);
 useEffect(()=>{if(!tenantId||typeof window==="undefined")return;const params=new URLSearchParams(window.location.search);const id=params.get("metaConnection");const metaError=params.get("metaError");if(!id&&!metaError)return;if(metaError)setError(metaError);const clearReturn=()=>{params.delete("metaConnection");params.delete("metaError");const query=params.toString();window.history.replaceState({},document.title,`${window.location.pathname}${query?`?${query}`:""}`)};if(!id){clearReturn();return;}api<any>(`/v1/tenants/${tenantId}/channels/meta/oauth/discovery/${encodeURIComponent(id)}`).then(data=>setDiscovery({...data,id})).catch(reason=>setError(reason instanceof Error?reason.message:"Unable to finish Meta connection.")).finally(clearReturn)},[tenantId]);
 async function submit(e:FormEvent){e.preventDefault();if(!businessId)return;setBusy("create");setError("");try{await api(`/v1/tenants/${tenantId}/channels`,{method:"POST",body:JSON.stringify({businessId,platform:"whatsapp",name:form.name,externalAccountId:form.externalAccountId,publicIdentifier:form.publicIdentifier||undefined,credentials:{accessToken:form.accessToken,whatsappBusinessAccountId:form.whatsappBusinessAccountId||undefined},testConnection:true})});setOpen(false);setForm({name:"",externalAccountId:"",publicIdentifier:"",accessToken:"",whatsappBusinessAccountId:""});setNotice("WhatsApp channel connected.");await load();onChanged?.()}catch(reason){setError(reason instanceof Error?reason.message:"Connection failed.")}finally{setBusy("")}}
 async function connectMeta(platform:"facebook"|"instagram"){if(!businessId)return;setBusy(platform);setError("");try{const response=await api<{authorizationUrl:string}>(`/v1/tenants/${tenantId}/channels/meta/oauth/start${qs({businessId,platform})}`);window.location.assign(response.authorizationUrl)}catch(reason){setError(reason instanceof Error?reason.message:"Unable to start Meta authorization.");setBusy("")}}
 async function completeMeta(pageId:string,platform:"facebook"|"instagram"){if(!discovery)return;setBusy(pageId);setError("");try{await api(`/v1/tenants/${tenantId}/channels/meta/oauth/discovery/${encodeURIComponent(discovery.id)}/complete`,{method:"POST",body:JSON.stringify({pageId,platform})});setDiscovery(null);setNotice(`${platform==="facebook"?"Facebook":"Instagram"} channel connected.`);await load();onChanged?.()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to connect selected account.")}finally{setBusy("")}}
 function startEdit(row:ChannelRow){setEditing(row);setEditForm({name:row.name,active:row.active,accessToken:"",appSecret:"",verifyToken:"",whatsappBusinessAccountId:""});setError("")}
 async function save(e:FormEvent){e.preventDefault();if(!editing)return;setBusy(editing.id);setError("");try{const credentials=Object.fromEntries(Object.entries({accessToken:editForm.accessToken,appSecret:editForm.appSecret,verifyToken:editForm.verifyToken,whatsappBusinessAccountId:editForm.whatsappBusinessAccountId}).filter(([,value])=>value.trim()));await api(`/v1/tenants/${tenantId}/channels/${editing.id}`,{method:"PATCH",body:JSON.stringify({name:editForm.name,active:editForm.active,...(Object.keys(credentials).length?{credentials}:{})})});setEditing(null);setNotice("Channel updated.");await load();onChanged?.()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to update channel.")}finally{setBusy("")}}
 async function test(row:ChannelRow){setBusy(row.id);setError("");try{const result=await api<{detail?:string}>(`/v1/tenants/${tenantId}/channels/${row.id}/test`,{method:"POST",body:"{}"});setNotice(result.detail||"Connection test completed.");await load()}catch(reason){setError(reason instanceof Error?reason.message:"Connection test failed.")}finally{setBusy("")}}
 async function lifecycle(row:ChannelRow,action:"pause"|"resume"|"reconnect"){setBusy(row.id);setError("");try{await api(`/v1/tenants/${tenantId}/channels/${row.id}/${action}`,{method:"POST",body:"{}"});setNotice(`${row.name} ${action==="pause"?"paused":action==="resume"?"resumed":"reconnected"}.`);await load();onChanged?.()}catch(reason){setError(reason instanceof Error?reason.message:`Unable to ${action} channel.`)}finally{setBusy("")}}
 async function remove(row:ChannelRow){if(!await confirmAction({title:`Delete ${row.name}?`,description:"Stored credentials will be removed and processing will stop. The same provider account can be connected again later."}))return;setBusy(row.id);setError("");try{await api(`/v1/tenants/${tenantId}/channels/${row.id}/remove`,{method:"DELETE"});if(editing?.id===row.id)setEditing(null);setNotice(`${row.name} deleted.`);await load();onChanged?.()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to delete channel.")}finally{setBusy("")}}
 async function diagnostics(row:ChannelRow){setBusy(row.id);setError("");try{setDiag(await api<any>(`/v1/tenants/${tenantId}/channels/${row.id}/diagnostics`))}catch(reason){setError(reason instanceof Error?reason.message:"Unable to load channel diagnostics.")}finally{setBusy("")}}
 return <><SectionHeader title={embedded?`${businessName||"Business"} channels`:"Channels"} description={embedded?"Connect and maintain the channels owned by this business.":"Connect Facebook and Instagram through Meta OAuth, or attach WhatsApp Business credentials. Each channel stays scoped to the selected business."} action={canManage?<button className="button primary" disabled={!businessId||Boolean(busy)} onClick={()=>setOpen(true)}>+ Connect channel</button>:undefined}/>{error&&<div role="alert" className="alert error">{error}</div>}{notice&&<div role="status" className="alert success">{notice}</div>}{!businessId&&<div className="alert warn">Choose a business before connecting a channel.</div>}<div className="table-wrap"><table><thead><tr><th>Account</th><th>Platform</th><th>Status</th><th>Data links</th><th>Activity</th><th>Actions</th></tr></thead><tbody>{loading&&!rows.length?<tr><td colSpan={6}><p role="status" className="muted small" style={{padding:12}}>Loading channels…</p></td></tr>:rows.map(row=><tr key={row.id}><td><strong>{row.name}</strong><small>{row.external_account_id}</small></td><td className="capitalize">{row.platform}</td><td><Badge tone={row.connection_status==="connected"&&row.active?"good":row.connection_status==="degraded"?"bad":"warn"}>{row.active?row.connection_status:"paused"}</Badge></td><td>{row.linked_collections||0} collections</td><td><small>Webhook {date(row.last_webhook_at)}<br/>Delivery {date(row.last_delivery_at)}</small></td><td><div className="row"><button className="button ghost smallbtn" disabled={busy===row.id} onClick={()=>void test(row)}>Test</button><button className="button ghost smallbtn" disabled={busy===row.id} onClick={()=>void diagnostics(row)}>Details</button>{canManage&&<><button className="button ghost smallbtn" onClick={()=>startEdit(row)}>Edit</button><button className="button ghost smallbtn" disabled={busy===row.id} onClick={()=>void lifecycle(row,row.active?"pause":"resume")}>{row.active?"Pause":"Resume"}</button>{row.connection_status!=="connected"&&<button className="button ghost smallbtn" disabled={busy===row.id} onClick={()=>void lifecycle(row,"reconnect")}>Reconnect</button>}<button className="button danger smallbtn" disabled={busy===row.id} onClick={()=>void remove(row)}>Delete</button></>}</div></td></tr>)}</tbody></table>{loadError&&!rows.length&&<div role="alert" className="channel-load-error">{loadError}<button type="button" className="button ghost smallbtn" disabled={loading} onClick={()=>void load()}>{loading?"Loading…":"Retry"}</button></div>}{!loading&&!loadError&&!rows.length&&<Empty>No channels connected to this business yet. Use “Connect channel” to get started.</Empty>}</div>{open&&<Modal title="Connect a channel" onClose={()=>!busy&&setOpen(false)}><div className="stack"><div className="panel stack"><h3>Facebook / Instagram</h3><p className="muted">Use Meta authorization so Page and Instagram professional accounts can be discovered without copying long-lived tokens into the browser form.</p><div className="row"><button className="button primary" disabled={Boolean(busy)||!businessId} onClick={()=>void connectMeta("facebook")}>Connect Facebook Page</button><button className="button" disabled={Boolean(busy)||!businessId} onClick={()=>void connectMeta("instagram")}>Connect Instagram</button></div></div><div className="panel"><h3>WhatsApp Business</h3><form className="stack" onSubmit={submit}><Field label="Account name"><input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></Field><Field label="Phone Number ID"><input required value={form.externalAccountId} onChange={e=>setForm({...form,externalAccountId:e.target.value})}/></Field><Field label="Public phone / identifier"><input value={form.publicIdentifier} onChange={e=>setForm({...form,publicIdentifier:e.target.value})}/></Field><Field label="WhatsApp Business Account ID"><input value={form.whatsappBusinessAccountId} onChange={e=>setForm({...form,whatsappBusinessAccountId:e.target.value})}/></Field><Field label="Permanent/System User access token"><input type="password" autoComplete="off" required value={form.accessToken} onChange={e=>setForm({...form,accessToken:e.target.value})}/></Field><button className="button primary" disabled={Boolean(busy)}>{busy==="create"?"Connecting…":"Connect WhatsApp"}</button></form></div></div></Modal>}{editing&&<Modal title="Edit channel" onClose={()=>!busy&&setEditing(null)}><form className="stack" onSubmit={save}><p className="muted">{editing.platform} · provider account ID is immutable; reconnect a different account instead.</p><Field label="Display name"><input required value={editForm.name} onChange={e=>setEditForm({...editForm,name:e.target.value})}/></Field><label className="chip-check"><input type="checkbox" checked={editForm.active} onChange={e=>setEditForm({...editForm,active:e.target.checked})}/> Active</label><Field label="Rotate access token" hint="Optional. Leave blank to keep the current token."><input type="password" autoComplete="off" value={editForm.accessToken} onChange={e=>setEditForm({...editForm,accessToken:e.target.value})}/></Field>{editing.platform!=="whatsapp"&&<><Field label="Rotate app secret" hint="Optional"><input type="password" autoComplete="off" value={editForm.appSecret} onChange={e=>setEditForm({...editForm,appSecret:e.target.value})}/></Field><Field label="Rotate verify token" hint="Optional"><input type="password" autoComplete="off" value={editForm.verifyToken} onChange={e=>setEditForm({...editForm,verifyToken:e.target.value})}/></Field></>}{editing.platform==="whatsapp"&&<Field label="WhatsApp Business Account ID" hint="Optional credential rotation"><input autoComplete="off" value={editForm.whatsappBusinessAccountId} onChange={e=>setEditForm({...editForm,whatsappBusinessAccountId:e.target.value})}/></Field>}<button className="button primary" disabled={busy===editing.id}>{busy===editing.id?"Saving…":"Save changes"}</button></form></Modal>}{discovery&&<Modal title="Choose Meta account" onClose={()=>!busy&&setDiscovery(null)}><div className="stack"><p>{discovery.requestedPlatform==="facebook"?"Choose a Facebook Page to connect.":"Choose a Page linked to a professional Instagram account."}</p>{!(discovery.pages||[]).length&&<Empty>No Pages were returned by Meta. Check Page access and the app permissions, then retry.</Empty>}{(discovery.pages||[]).map((page:any)=><div className="list-row" key={page.id}><div><strong>{page.name}</strong><span>Page {page.id}{page.instagram?` · Instagram @${page.instagram.username||page.instagram.id}`:""}</span></div><div className="row">{discovery.requestedPlatform==="facebook"?<button className="button primary" disabled={Boolean(busy)} onClick={()=>void completeMeta(page.id,"facebook")}>Connect Facebook Page</button>:<button className="button primary" disabled={Boolean(busy)||!page.instagram} onClick={()=>void completeMeta(page.id,"instagram")}>{page.instagram?"Connect Instagram":"No Instagram account"}</button>}</div></div>)}</div></Modal>}{diag&&<Modal title="Channel diagnostics" onClose={()=>setDiag(null)}><div className="detail-list"><div><span>Status</span><b>{diag.channel?.active?diag.channel?.connection_status:"paused"}</b></div><div><span>Open conversations</span><b>{diag.channel?.open_conversations||0}</b></div><div><span>Failed last 24h</span><b>{diag.channel?.failed_24h||0}</b></div><div><span>Last inbound</span><b>{date(diag.channel?.last_inbound_at)}</b></div><div><span>Last outbound</span><b>{date(diag.channel?.last_outbound_at)}</b></div></div><h4>Credential metadata</h4>{diag.credentials?.map((credential:any)=><div className="list-row" key={credential.credential_type}><div><strong>{credential.credential_type}</strong><span>{credential.key_hint||"stored securely"}</span></div><small>{credential.expires_at?date(credential.expires_at):"no known expiry"}</small></div>)}</Modal>}</>;
}
type InboxChannel={id:string;platform:string;name:string};
type InboxConversation={id:string;channel_account_id:string;external_contact_id:string;display_name?:string|null;phone?:string|null;platform:string;channel_name:string;business_name:string;mode:string;training_active:boolean;last_message_at?:string|null;last_message_text?:string|null};
type InboxMessage={id:string;direction:string;sender_type:string;created_at:string;text_content?:string|null;media?:Array<{id:string;mimeType:string;kind:string;publicUrl:string|null;originalName:string|null}>;delivery_status?:string|null};
type InboxDetail={conversation:InboxConversation;messages:InboxMessage[]};

function conversationContactName(conversation:InboxConversation){
 const saved=String(conversation.display_name||"").trim();if(saved)return saved;
 if(conversation.platform==="facebook")return "Facebook customer";
 if(conversation.platform==="instagram")return "Instagram customer";
 if(conversation.platform==="whatsapp")return "WhatsApp customer";
 return "Customer";
}
function facebookProfileUrl(conversation:InboxConversation){
 const id=String(conversation.external_contact_id||"");
 return conversation.platform==="facebook"&&/^\d+$/.test(id)?`https://www.facebook.com/profile.php?id=${encodeURIComponent(id)}`:null;
}
function ConversationContactName({conversation}:{conversation:InboxConversation}){
 const name=conversationContactName(conversation);const profileUrl=facebookProfileUrl(conversation);
 return profileUrl?<a className="inbox-contact-name facebook-profile-link" href={profileUrl} target="_blank" rel="noopener noreferrer" aria-label={`${name} on Facebook (opens in a new tab)`}>{name}<span aria-hidden="true"> ↗</span></a>:<strong className="inbox-contact-name">{name}</strong>;
}

function Conversations({tenantId,businessId}:{tenantId:string;businessId:string}){
 const pageSize=25;const businessScope=`${tenantId}:${businessId}`;
 const [channelFilter,setChannelFilter]=useState({scope:"",id:""});const channelId=channelFilter.scope===businessScope?channelFilter.id:"";
 const [period,setPeriod]=useState<"all"|"24h"|"7d">("all");const [pageState,setPageState]=useState({scope:"",value:0});const page=pageState.scope===businessScope?pageState.value:0;
 const [listData,setListData]=useState<{scope:string;rows:InboxConversation[];total:number}>({scope:"",rows:[],total:0});const [listError,setListError]=useState<{scope:string;message:string}|null>(null);
 const [channelData,setChannelData]=useState<{scope:string;rows:InboxChannel[]}>({scope:"",rows:[]});const [channelError,setChannelError]=useState<{scope:string;message:string}|null>(null);
 const [selected,setSelected]=useState<InboxDetail|null>(null);const [text,setText]=useState("");const [reloadKey,setReloadKey]=useState(0);
 const [detailLoading,setDetailLoading]=useState(false);const [sending,setSending]=useState(false);const [actionError,setActionError]=useState("");const detailRequestVersion=useRef(0);const profilePoll=useRef({scope:"",attempt:0});
 const listScope=JSON.stringify([tenantId,businessId,channelId,period,page,reloadKey]);
 const profilePollScope=JSON.stringify([tenantId,businessId,channelId,period,page]);
 const rows=listData.scope===listScope?listData.rows:[];const total=listData.scope===listScope?listData.total:0;
 const loadError=listError?.scope===listScope?listError.message:"";const loading=listData.scope!==listScope&&!loadError;
 const channels=channelData.scope===businessScope?channelData.rows:[];const channelsError=channelError?.scope===businessScope?channelError.message:"";const channelLoading=channelData.scope!==businessScope&&!channelsError;
 function goToPage(value:number){setPageState({scope:businessScope,value:Math.max(0,value)});}

 useEffect(()=>{
   if(!tenantId)return;
   let active=true;let retryTimer:ReturnType<typeof setTimeout>|undefined;
   async function fetchConversations(){
     try{
       const data=await api<{conversations:InboxConversation[];total:number;profileLookupPending?:boolean}>(`/v1/tenants/${tenantId}/conversations${qs({businessId,channelId,period:period==="all"?undefined:period,limit:pageSize,offset:page*pageSize})}`);
       if(!active)return;
       const nextTotal=Number(data.total||0);
       if((nextTotal===0&&page>0)||(nextTotal>0&&page*pageSize>=nextTotal)){setPageState({scope:businessScope,value:nextTotal===0?0:Math.max(0,Math.ceil(nextTotal/pageSize)-1)});return;}
       setListData({scope:listScope,rows:data.conversations||[],total:nextTotal});
       if(data.profileLookupPending){
         if(profilePoll.current.scope!==profilePollScope)profilePoll.current={scope:profilePollScope,attempt:0};
         if(profilePoll.current.attempt<3){const attempt=++profilePoll.current.attempt;retryTimer=setTimeout(()=>{if(active)setReloadKey(value=>value+1);},attempt*1200);}
       }else profilePoll.current={scope:profilePollScope,attempt:0};
     }catch(error){if(active)setListError({scope:listScope,message:error instanceof Error?error.message:"Unable to load conversations."});}
   }
   void fetchConversations();
   return()=>{active=false;if(retryTimer)clearTimeout(retryTimer);};
 },[tenantId,businessId,businessScope,channelId,period,page,pageSize,listScope,profilePollScope]);

 useEffect(()=>{
   if(!tenantId)return;
   let active=true;
   api<{channels:InboxChannel[]}>(`/v1/tenants/${tenantId}/channels${qs({businessId})}`)
     .then(data=>{if(active)setChannelData({scope:businessScope,rows:data.channels||[]});})
     .catch(error=>{if(active)setChannelError({scope:businessScope,message:error instanceof Error?error.message:"Unable to load channel filters."});});
   return()=>{active=false;};
 },[tenantId,businessId,businessScope]);

 async function open(id:string){
   const version=++detailRequestVersion.current;setDetailLoading(true);setActionError("");
   try{const data=await api<InboxDetail>(`/v1/tenants/${tenantId}/conversations/${id}`);if(version===detailRequestVersion.current)setSelected(data);}
   catch(error){if(version===detailRequestVersion.current)setActionError(error instanceof Error?error.message:"Unable to open conversation.");}
   finally{if(version===detailRequestVersion.current)setDetailLoading(false);}
 }
 async function mode(nextMode:string){
   if(!selected)return;setSending(true);setActionError("");
   try{await api(`/v1/tenants/${tenantId}/conversations/${selected.conversation.id}/mode`,{method:"POST",body:JSON.stringify({mode:nextMode})});await open(selected.conversation.id);setReloadKey(value=>value+1);}
   catch(error){setActionError(error instanceof Error?error.message:"Unable to update conversation mode.");}
   finally{setSending(false);}
 }
 async function reply(){
   if(!selected||!text.trim()||sending)return;setSending(true);setActionError("");
   try{await api(`/v1/tenants/${tenantId}/conversations/${selected.conversation.id}/reply`,{method:"POST",body:JSON.stringify({text})});setText("");await open(selected.conversation.id);setReloadKey(value=>value+1);}
   catch(error){setActionError(error instanceof Error?error.message:"Unable to send reply.");}
   finally{setSending(false);}
 }

 const pageCount=Math.ceil(total/pageSize);const firstRow=total?page*pageSize+1:0;const lastRow=Math.min((page+1)*pageSize,total);
 if(detailLoading&&!selected)return <><SectionHeader title="Unified inbox" description="Loading conversation…"/><Loading/></>;
 if(selected){const c=selected.conversation;return <><button className="back-button" onClick={()=>{setSelected(null);setActionError("");}}>← Inbox</button><SectionHeader title={<ConversationContactName conversation={c}/>} description={`${c.platform} · ${c.channel_name} · ${c.business_name}${c.training_active?" · Training ON: reply here or in an eligible native inbox":""}`} action={<div className="button-row"><button className={cx("button",c.mode==="AI"?"primary":"ghost")} disabled={c.training_active||sending} onClick={()=>void mode("AI")}>AI mode</button><button className={cx("button",c.mode==="HUMAN"?"danger":"ghost")} disabled={sending} onClick={()=>void mode("HUMAN")}>Human takeover</button></div>}/>{actionError&&<div className="alert error inbox-error" role="alert">{actionError}</div>}<div className="conversation"><div className="message-list">{selected.messages.map(message=><div key={message.id} className={cx("bubble",message.direction==="OUTBOUND"?"out":"in")}><small>{message.sender_type} · {date(message.created_at)}</small>{message.text_content&&<p>{message.text_content}</p>}{message.media&&message.media.length>0&&<div className="media-count">{message.media.length} attachment(s)</div>}<small>{message.delivery_status||""}</small></div>)}</div><div className="composer">{c.training_active&&<small>Successful HUMAN replies sent here during Training ON can become examples when paired with customer messages. Verified Facebook Page Inbox echoes can also be eligible.</small>}<textarea value={text} onChange={event=>setText(event.target.value)} placeholder="Reply as a human…"/><button className="button primary" disabled={sending||!text.trim()} onClick={()=>void reply()}>{sending?"Sending…":"Send"}</button></div></div></>}

 return <><SectionHeader title="Unified inbox" description="AI and human conversations from every connected channel. Human takeover suppresses pending automated replies."/><section className="inbox-toolbar" aria-label="Conversation filters"><label className="inbox-filter"><span>Channel</span><select aria-label="Filter conversations by channel" value={channelId} onChange={event=>{setChannelFilter({scope:businessScope,id:event.target.value});goToPage(0);}} disabled={channelLoading}><option value="">All channels</option>{channels.map(channel=><option key={channel.id} value={channel.id}>{String(channel.platform||"channel").toUpperCase()} · {channel.name}</option>)}</select></label><label className="inbox-filter"><span>Activity</span><select aria-label="Filter conversations by time" value={period} onChange={event=>{setPeriod(event.target.value as "all"|"24h"|"7d");goToPage(0);}}><option value="all">Any time</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option></select></label><div className="inbox-filter-summary"><strong>{fmt(total)}</strong><span>open conversation{total===1?"":"s"}</span></div></section>{channelsError&&<div className="alert error inbox-error" role="alert">Channel filters could not be loaded: {channelsError}</div>}{loadError&&<div className="alert error inbox-error" role="alert">{loadError}<button type="button" className="button smallbtn" disabled={loading} onClick={()=>setReloadKey(value=>value+1)}>Retry</button></div>}<div className="inbox-list">{rows.map(conversation=>{const name=conversationContactName(conversation);return <div key={conversation.id} className="inbox-row"><div className="avatar">{name[0]?.toUpperCase()||"C"}</div><div className="grow inbox-row-content"><div className="row-title"><ConversationContactName conversation={conversation}/><span>{date(conversation.last_message_at)}</span></div><button type="button" className="inbox-row-open" aria-label={`Open conversation with ${name}`} onClick={()=>void open(conversation.id)}><span className="inbox-row-preview">{conversation.last_message_text||"Media / system activity"}</span></button><div className="meta-line"><span>{String(conversation.platform||"").toUpperCase()}</span><span>{conversation.channel_name}</span><Badge tone={conversation.training_active||conversation.mode==="HUMAN"?"warn":"brand"}>{conversation.training_active?"TRAINING ON":conversation.mode}</Badge></div></div></div>;})}{loading&&!rows.length&&<div className="inbox-loading" role="status"><span className="spinner"/>Loading conversations…</div>}{!loading&&!loadError&&!rows.length&&<Empty>{channelId||period!=="all"?"No conversations match these filters. Try another channel or time range.":"No open conversations yet."}</Empty>}</div><nav className="inbox-pagination" aria-label="Conversation pages"><span>Showing {firstRow}–{lastRow} of {fmt(total)}</span><div><button type="button" className="button" disabled={page===0||loading} onClick={()=>goToPage(page-1)}>Previous</button><span aria-live="polite">{pageCount?`Page ${page+1} of ${pageCount}`:"Page 0 of 0"}</span><button type="button" className="button" disabled={!pageCount||page+1>=pageCount||loading} onClick={()=>goToPage(page+1)}>Next</button></div></nav></>;
}

function BusinessActions({tenantId,businessId,onCatalogOpen}:{tenantId:string;businessId:string;onCatalogOpen:(target:CatalogNavigationTarget)=>void}){
 type ActionMedia={id:string;url:string|null;mimeType:string;role?:string;order?:number;originalName?:string|null};
 type OrderItem={id:string;title_snapshot:string;sku_snapshot?:string|null;quantity:number|string;unit_price:number|string;total:number|string;attributes_snapshot?:Record<string,unknown>;collection_item_id?:string|null;collection_id?:string|null;collection_name?:string|null;collection_purpose?:string|null;media?:ActionMedia[]};
 type ActionRow={id:string;business_id?:string;status:string;created_at:string;order_number?:string;currency?:string;subtotal?:number|string;total?:number|string;items?:OrderItem[];channel_name?:string|null;platform?:string|null;source?:string;conversation_id?:string|null;customer_snapshot?:Record<string,unknown>;delivery_metadata?:Record<string,unknown>;payment_metadata?:Record<string,unknown>;metadata?:Record<string,unknown>;collection_item_id?:string|null;starts_at?:string;ends_at?:string|null;timezone?:string;service_title?:string|null;service_data?:Record<string,unknown>|null;service_collection_id?:string|null;service_collection_name?:string|null;service_collection_purpose?:string|null;service_media?:ActionMedia[];interest?:string|null;stage?:string|null;assigned_user_id?:string|null;channel_account_id?:string|null;request_json?:unknown;subject?:string|null;priority?:string|null;description?:string|null};
 type ActionList={orders?:ActionRow[];bookings?:ActionRow[];leads?:ActionRow[];quotes?:ActionRow[];"support-cases"?:ActionRow[];cases?:ActionRow[]};
 const tabs=["orders","bookings","leads","quotes","support-cases"] as const;
 const [tab,setTab]=useState<(typeof tabs)[number]>("orders");
 const scopeKey=`${tenantId}:${businessId}:${tab}`;
 const [data,setData]=useState<{scope:string;rows:ActionRow[];loading:boolean;error:string}>({scope:"",rows:[],loading:false,error:""});
 const [selected,setSelected]=useState<{scope:string;order:ActionRow}|null>(null);
 const [selectedBooking,setSelectedBooking]=useState<{scope:string;booking:ActionRow}|null>(null);
 const [updating,setUpdating]=useState<{scope:string;id:string}|null>(null);
 const requestVersion=useRef(0);const activeScope=useRef(scopeKey);const loadController=useRef<AbortController|null>(null);
 const rows=data.scope===scopeKey?data.rows:[];
 const loading=data.scope!==scopeKey||data.loading;
 const error=data.scope===scopeKey?data.error:"";
 const selectedOrder=selected?.scope===scopeKey?rows.find(row=>row.id===selected.order.id)||selected.order:null;
 const selectedService=selectedBooking?.scope===scopeKey?rows.find(row=>row.id===selectedBooking.booking.id)||selectedBooking.booking:null;
 const busy=updating?.scope===scopeKey?updating.id:"";
 const transitions:Record<string,string[]>={pending:["confirmed","cancelled"],confirmed:["processing","cancelled"],processing:["shipped","completed","cancelled"],shipped:["completed","returned"],completed:["returned"],cancelled:[],returned:[]};
 const bookingTransitions:Record<string,string[]>={pending:["confirmed","cancelled"],requested:["confirmed","cancelled"],confirmed:["completed","cancelled"],completed:[],cancelled:[]};
 const load=useCallback(async()=>{
   if(!tenantId)return;
   loadController.current?.abort();const controller=new AbortController();loadController.current=controller;
   const version=++requestVersion.current;
   setData(previous=>({scope:scopeKey,rows:previous.scope===scopeKey?previous.rows:[],loading:true,error:""}));
   try{
     const response=await api<ActionList>(`/v1/tenants/${tenantId}/${tab}${qs({businessId})}`,{signal:controller.signal});
     if(version!==requestVersion.current||controller.signal.aborted)return;
     setData({scope:scopeKey,rows:tab==="support-cases"?response.cases||[]:response[tab]||[],loading:false,error:""});
   }catch(reason){
     if(version!==requestVersion.current||controller.signal.aborted)return;
     setData(previous=>({...previous,loading:false,error:reason instanceof Error?reason.message:"Unable to load business actions."}));
   }
 },[tenantId,businessId,tab,scopeKey]);
 useEffect(()=>{activeScope.current=scopeKey;void load();return()=>{loadController.current?.abort();requestVersion.current+=1;};},[load,scopeKey]);
 async function patch(path:string,body:unknown,id:string){
   setUpdating({scope:scopeKey,id});setData(previous=>({...previous,error:""}));
   try{await api(path,{method:"PATCH",body:JSON.stringify(body)});if(activeScope.current===scopeKey)await load();}
   catch(reason){if(activeScope.current===scopeKey)setData(previous=>({...previous,error:reason instanceof Error?reason.message:"Unable to update this record."}));}
   finally{setUpdating(previous=>previous?.scope===scopeKey&&previous.id===id?null:previous);}
 }
 function money(value:unknown,currency?:string){return `${currency||""} ${Number(value||0).toFixed(2)}`.trim();}
 function catalogHref(collectionId?:string|null,itemId?:string|null,sourceBusinessId?:string|null){
   if(!collectionId)return null;
   const params=new URLSearchParams({view:"data",tenantId});
   const targetBusinessId=sourceBusinessId||businessId;
   if(targetBusinessId)params.set("businessId",targetBusinessId);
   params.set("collectionId",collectionId);
   if(itemId)params.set("itemId",itemId);
   return `/?${params.toString()}`;
 }
 function catalogLink(collectionId:string|null|undefined,itemId:string|null|undefined,sourceBusinessId:string|null|undefined,label:string){
   const href=catalogHref(collectionId,itemId,sourceBusinessId);
   if(!href||!collectionId)return null;
   return <Link href={href} onClick={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onCatalogOpen({collectionId,itemId,businessId:sourceBusinessId});}}>{label}</Link>;
 }
 function itemImage(media:ActionMedia[]|undefined,title:string){
   const image=media?.find(entry=>entry.mimeType?.startsWith("image/"));
   if(!image)return <div className="action-item-image placeholder" aria-label={`No image for ${title}`}><span aria-hidden="true">▧</span></div>;
   const src=image.url||`${API_URL}/v1/tenants/${tenantId}/media/${image.id}/content`;
   return <div className="action-item-image"><Image src={src} alt={title} width={64} height={64} sizes="64px" unoptimized/></div>;
 }
 function orderItemPreview(item:OrderItem,sourceBusinessId?:string){
   const href=catalogHref(item.collection_id,item.collection_item_id,sourceBusinessId);
   return <div className="action-item-preview" key={item.id}>{itemImage(item.media,item.title_snapshot)}<div className="action-item-copy"><strong>{item.title_snapshot} × {String(item.quantity)}</strong>{item.sku_snapshot&&<small>SKU: {item.sku_snapshot}</small>}{href?catalogLink(item.collection_id,item.collection_item_id,sourceBusinessId,`Data catalog · ${item.collection_name||"Open source"}`):<small>Catalog source unavailable</small>}</div></div>;
 }
 function actionStatus(row:ActionRow,kind:"orders"|"bookings"|"leads"|"quotes"|"support-cases"){
   const options=kind==="orders"?[row.status,...(transitions[row.status]||[])]:kind==="bookings"?[row.status,...(bookingTransitions[row.status]||[])]:kind==="leads"?["new","qualified","contacted","proposal","won","lost"]:kind==="quotes"?["requested","reviewing","quoted","accepted","declined","closed"]:["open","pending","resolved","closed"];
   const path=kind==="orders"?`/v1/tenants/${tenantId}/orders/${row.id}`:kind==="bookings"?`/v1/tenants/${tenantId}/bookings/${row.id}`:kind==="leads"?`/v1/tenants/${tenantId}/leads/${row.id}`:kind==="quotes"?`/v1/tenants/${tenantId}/quotes/${row.id}`:`/v1/tenants/${tenantId}/support-cases/${row.id}`;
   const field=kind==="leads"?"stage":"status";
   const current=kind==="leads"?row.stage||"new":row.status;
   return <select aria-label={`Status for ${row.order_number||row.service_title||row.subject||kind}`} value={current} disabled={busy===row.id||!options.filter(option=>option!==current).length} onChange={event=>void patch(path,{[field]:event.target.value},row.id)}>{options.map(option=><option key={option} value={option}>{option}</option>)}</select>;
 }
 function label(key:string){return key.replace(/_/g," ").replace(/([a-z])([A-Z])/g,"$1 $2");}
 function metadataValue(value:unknown):ReactNode{
   if(value===null||value===undefined||value==="")return "—";
   if(Array.isArray(value))return <ul>{value.map((entry,index)=><li key={index}>{metadataValue(entry)}</li>)}</ul>;
   if(typeof value==="object")return <dl className="order-metadata">{Object.entries(value).map(([key,entry])=><div key={key}><dt>{label(key)}</dt><dd>{metadataValue(entry)}</dd></div>)}</dl>;
   return String(value);
 }
 function metadataSection(title:string,value:unknown){
   const populated=value!==null&&typeof value==="object"&&Object.keys(value).length>0;
   return <section className="order-detail-card"><h4>{title}</h4>{populated?metadataValue(value):<p className="muted small">No {title.toLowerCase()} details supplied.</p>}</section>;
 }
 return <>
   <SectionHeader title="Business actions" description="Review orders and other outcomes created from customer conversations." action={<button type="button" className="button ghost" disabled={loading||!!busy} onClick={()=>void load()}>{loading?"Refreshing…":"Refresh"}</button>}/>
   {error&&<div role="alert" className="alert error">{error}</div>}
   <div className="tabs inline-tabs">{tabs.map(t=><button type="button" className={tab===t?"active":""} onClick={()=>setTab(t)} key={t}>{t==="support-cases"?"Support":t[0].toUpperCase()+t.slice(1)}</button>)}</div>
   {loading&&<p className="muted small" role="status">Loading {tab==="support-cases"?"support cases":tab}…</p>}
   <div className="table-wrap business-actions-table desktop-only" aria-busy={loading}>
     <table><thead><tr>{tab==="orders"?<><th>Order / source catalog</th><th>Status</th><th>Total</th><th>Channel / source</th><th>Date</th><th>Details</th></>:tab==="bookings"?<><th>Service / source catalog</th><th>Status</th><th>Starts</th><th>Timezone</th><th>Date</th><th>Details</th></>:tab==="leads"?<><th>Interest</th><th>Stage</th><th>Assigned</th><th>Source</th><th>Date</th></>:tab==="quotes"?<><th>Quote</th><th>Status</th><th>Request</th><th>Assigned</th><th>Date</th></>:<><th>Case</th><th>Status</th><th>Priority</th><th>Description</th><th>Date</th></>}</tr></thead><tbody>
     {rows.map(r=>tab==="orders"?<tr key={r.id}>
       <td><strong>{r.order_number}</strong><div className="order-preview-items">{(r.items||[]).slice(0,2).map(item=>orderItemPreview(item,r.business_id))}{(r.items||[]).length>2&&<small>+ {(r.items||[]).length-2} more item(s)</small>}{!r.items?.length&&<small>No line items</small>}</div></td>
       <td>{actionStatus(r,"orders")}</td><td>{money(r.total,r.currency)}</td><td><strong>{r.channel_name||"Direct"}</strong><small>{[r.platform,r.source].filter(Boolean).join(" · ")||"—"}</small></td><td>{date(r.created_at)}</td><td><button type="button" className="button ghost smallbtn" onClick={()=>setSelected({scope:scopeKey,order:r})} aria-label={`View details for ${r.order_number}`}>View details</button></td>
     </tr>:tab==="bookings"?<tr key={r.id}><td><div className="action-item-preview">{itemImage(r.service_media,r.service_title||"Booked service")}<div className="action-item-copy"><strong>{r.service_title||"Service / resource unavailable"}</strong><small>{r.service_collection_name||"No source catalog"}</small>{catalogLink(r.service_collection_id,r.collection_item_id,r.business_id,"Open data catalog")}</div></div></td><td>{actionStatus(r,"bookings")}</td><td>{date(r.starts_at)}</td><td>{r.timezone||"—"}</td><td>{date(r.created_at)}</td><td><button type="button" className="button ghost smallbtn" onClick={()=>setSelectedBooking({scope:scopeKey,booking:r})}>View details</button></td></tr>:tab==="leads"?<tr key={r.id}><td>{r.interest||"Lead"}</td><td>{actionStatus(r,"leads")}</td><td>{r.assigned_user_id||"Unassigned"}</td><td>{r.channel_account_id?"Channel":"Direct"}</td><td>{date(r.created_at)}</td></tr>:tab==="quotes"?<tr key={r.id}><td><strong>{r.id.slice(0,8)}</strong></td><td>{actionStatus(r,"quotes")}</td><td><small>{JSON.stringify(r.request_json)}</small></td><td>{r.assigned_user_id||"Unassigned"}</td><td>{date(r.created_at)}</td></tr>:<tr key={r.id}><td><strong>{r.subject||r.id.slice(0,8)}</strong></td><td>{actionStatus(r,"support-cases")}</td><td>{r.priority||"normal"}</td><td><small>{r.description||"—"}</small></td><td>{date(r.created_at)}</td></tr>)}
     </tbody></table>
   </div>
   <div className="action-card-list mobile-only" aria-busy={loading}>
     {rows.map(r=>tab==="orders"?<article className="action-card" key={r.id}>
       <div className="action-card-heading"><div><strong>{r.order_number||"Order"}</strong><small>{date(r.created_at)}</small></div><Badge tone={r.status==="cancelled"||r.status==="returned"?"bad":r.status==="pending"?"warn":"good"}>{r.status}</Badge></div>
       <div className="order-preview-items">{(r.items||[]).slice(0,3).map(item=>orderItemPreview(item,r.business_id))}{(r.items||[]).length>3&&<small>+ {(r.items||[]).length-3} more item(s)</small>}{!r.items?.length&&<small>No line items</small>}</div>
       <div className="action-card-meta"><span>Total</span><strong>{money(r.total,r.currency)}</strong><span>Channel / source</span><strong>{r.channel_name||"Direct"} · {r.source||"—"}</strong></div>
       <div className="action-card-footer">{actionStatus(r,"orders")}<button type="button" className="button ghost" onClick={()=>setSelected({scope:scopeKey,order:r})}>View order details</button></div>
     </article>:tab==="bookings"?<article className="action-card" key={r.id}>
       <div className="action-item-preview booking-item-preview">{itemImage(r.service_media,r.service_title||"Booked service")}<div className="action-item-copy"><strong>{r.service_title||"Service / resource unavailable"}</strong><small>{r.service_collection_name||"No source catalog"}</small>{catalogLink(r.service_collection_id,r.collection_item_id,r.business_id,"Open data catalog")}</div></div>
       <div className="action-card-meta"><span>Status</span><strong>{r.status}</strong><span>Starts</span><strong>{date(r.starts_at)} · {r.timezone||"—"}</strong><span>Received</span><strong>{date(r.created_at)}</strong></div>
       <div className="action-card-footer">{actionStatus(r,"bookings")}<button type="button" className="button ghost" onClick={()=>setSelectedBooking({scope:scopeKey,booking:r})}>View booking details</button></div>
     </article>:tab==="leads"?<article className="action-card" key={r.id}><div className="action-card-heading"><div><strong>{r.interest||"Lead"}</strong><small>{date(r.created_at)}</small></div><Badge>{r.stage||"new"}</Badge></div><div className="action-card-meta"><span>Assigned</span><strong>{r.assigned_user_id||"Unassigned"}</strong><span>Source</span><strong>{r.channel_account_id?"Channel":"Direct"}</strong></div><div className="action-card-footer">{actionStatus(r,"leads")}</div></article>:tab==="quotes"?<article className="action-card" key={r.id}><div className="action-card-heading"><div><strong>Quote · {r.id.slice(0,8)}</strong><small>{date(r.created_at)}</small></div><Badge>{r.status}</Badge></div><p className="action-card-description">{JSON.stringify(r.request_json)||"No request details"}</p><div className="action-card-footer">{actionStatus(r,"quotes")}<span>{r.assigned_user_id||"Unassigned"}</span></div></article>:<article className="action-card" key={r.id}><div className="action-card-heading"><div><strong>{r.subject||`Case · ${r.id.slice(0,8)}`}</strong><small>{date(r.created_at)}</small></div><Badge tone={r.priority==="urgent"||r.priority==="high"?"warn":"neutral"}>{r.priority||"normal"}</Badge></div><p className="action-card-description">{r.description||"No description supplied."}</p><div className="action-card-footer">{actionStatus(r,"support-cases")}</div></article>)}
   </div>
   {!loading&&!error&&!rows.length&&<Empty>No {tab} in this scope yet.</Empty>}
   {!loading&&rows.length>=50&&<p className="muted small">Showing the latest 50 records in this scope.</p>}
   {selectedOrder&&<Modal title={selectedOrder.order_number||"Order details"} onClose={()=>setSelected(null)}><div className="order-details">
     <div className="order-detail-summary"><Badge tone={selectedOrder.status==="cancelled"||selectedOrder.status==="returned"?"bad":selectedOrder.status==="pending"?"warn":"good"}>{selectedOrder.status}</Badge><strong>{money(selectedOrder.total,selectedOrder.currency)}</strong><span className="muted small">{date(selectedOrder.created_at)}</span></div>
     <section className="order-detail-card"><h4>Channel and attribution</h4><dl className="order-metadata"><div><dt>Channel</dt><dd>{selectedOrder.channel_name||"Direct"}{selectedOrder.platform&&` · ${selectedOrder.platform}`}</dd></div><div><dt>Created by</dt><dd className="capitalize">{selectedOrder.source||"—"}</dd></div><div><dt>Conversation</dt><dd>{selectedOrder.conversation_id||"—"}</dd></div></dl></section>
     <section className="order-detail-card"><h4>Items and source catalogs</h4><div className="order-item-detail-list">{(selectedOrder.items||[]).map(item=><article className="order-item-detail" key={item.id}>{itemImage(item.media,item.title_snapshot)}<div className="order-item-detail-main"><strong>{item.title_snapshot}</strong>{item.sku_snapshot&&<small>SKU: {item.sku_snapshot}</small>}{catalogLink(item.collection_id,item.collection_item_id,selectedOrder.business_id,`Open data catalog · ${item.collection_name||"Source item"}`)||<small>Source catalog is no longer available for this line item.</small>}{item.attributes_snapshot&&Object.keys(item.attributes_snapshot).length>0&&<div className="order-item-attributes">{metadataValue(item.attributes_snapshot)}</div>}</div><div className="order-item-detail-price"><span>Qty {String(item.quantity)}</span><span>{money(item.unit_price,selectedOrder.currency)} each</span><strong>{money(item.total,selectedOrder.currency)}</strong></div></article>)}{!selectedOrder.items?.length&&<p className="muted small">No line items were saved with this order.</p>}</div><div className="order-detail-totals"><span>Subtotal</span><strong>{money(selectedOrder.subtotal,selectedOrder.currency)}</strong><span>Total</span><strong>{money(selectedOrder.total,selectedOrder.currency)}</strong></div></section>
     <div className="order-detail-grid">{metadataSection("Customer",selectedOrder.customer_snapshot)}{metadataSection("Delivery",selectedOrder.delivery_metadata)}{metadataSection("Payment",selectedOrder.payment_metadata)}</div>
   </div></Modal>}
   {selectedService&&<Modal title={selectedService.service_title||"Service booking details"} onClose={()=>setSelectedBooking(null)}><div className="order-details"><div className="service-detail-hero">{itemImage(selectedService.service_media,selectedService.service_title||"Booked service")}<div><Badge tone={selectedService.status==="cancelled"?"bad":selectedService.status==="requested"||selectedService.status==="pending"?"warn":"good"}>{selectedService.status}</Badge><p>{selectedService.service_collection_name||"No source catalog"}</p>{catalogLink(selectedService.service_collection_id,selectedService.collection_item_id,selectedService.business_id,"Open source catalog item")}</div></div><section className="order-detail-card"><h4>Appointment</h4><dl className="order-metadata"><div><dt>Starts</dt><dd>{date(selectedService.starts_at)}</dd></div><div><dt>Ends</dt><dd>{selectedService.ends_at?date(selectedService.ends_at):"—"}</dd></div><div><dt>Timezone</dt><dd>{selectedService.timezone||"—"}</dd></div><div><dt>Received</dt><dd>{date(selectedService.created_at)}</dd></div><div><dt>Channel</dt><dd>{selectedService.channel_name||"Direct"}{selectedService.platform&&` · ${selectedService.platform}`}</dd></div><div><dt>Conversation</dt><dd>{selectedService.conversation_id||"—"}</dd></div></dl></section>{metadataSection("Customer",selectedService.customer_snapshot)}{metadataSection("Booking details",selectedService.metadata)}{selectedService.service_data&&metadataSection("Current catalog details",selectedService.service_data)}</div></Modal>}
 </>;
}

type TrainingAgentSummary={id:string;name:string};
type TrainingChannel={id:string;name:string;platform:string;default_agent_profile_id:string|null};
type TrainingSession={id:string;status:string;channel_account_id:string;created_at:string;captured_count:number;example_count:number;job_status?:string|null;job_error?:string|null};
type TrainingCapability={supported:boolean;reason:string;source?:string|null};
type TrainingExample={id:string;source:string;approval_status:string;input_text:string|null;ideal_response:string};
type TrainingJob={id:string;status:string;created_at:string;error:string|null};
type TrainingPrompt={id:string;version:number;status:string;source:string;created_at:string;assembled_prompt:string};
type TrainingDetail={agent:{active_prompt_version_id:string|null};prompts:TrainingPrompt[]};
function Training({tenantId,businessId}:{tenantId:string;businessId:string}){
 const [agents,setAgents]=useState<TrainingAgentSummary[]>([]);
 const [agentId,setAgentId]=useState("");
 const [channels,setChannels]=useState<TrainingChannel[]>([]);
 const [channelId,setChannelId]=useState("");
 const [sessions,setSessions]=useState<TrainingSession[]>([]);
 const [capability,setCapability]=useState<{channelId:string;value:TrainingCapability}|null>(null);
 const [examples,setExamples]=useState<TrainingExample[]>([]);
 const [jobs,setJobs]=useState<TrainingJob[]>([]);
 const [agent,setAgent]=useState<TrainingDetail|null>(null);
 const [form,setForm]=useState({inputText:"",idealResponse:""});
 const [testMessage,setTestMessage]=useState("How can you help me?");
 const [testResult,setTestResult]=useState<{promptId:string;response:string}|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 useEffect(()=>{
  if(!tenantId)return;
  Promise.all([
   api<{agents:TrainingAgentSummary[]}>(`/v1/tenants/${tenantId}/agents${qs({businessId})}`),
   api<{channels:TrainingChannel[]}>(`/v1/tenants/${tenantId}/channels${qs({businessId})}`),
  ]).then(([a,ch])=>{
   setAgents(a.agents||[]);
   setAgentId(v=>v&&a.agents?.some(item=>item.id===v)?v:a.agents?.[0]?.id||"");
   setChannels(ch.channels||[]);
  }).catch(e=>setError(e.message));
 },[tenantId,businessId]);
 const eligibleChannels=channels.filter(ch=>ch.default_agent_profile_id===agentId);
 const selectedChannelId=eligibleChannels.some(ch=>ch.id===channelId)?channelId:eligibleChannels[0]?.id||"";
 const loadAgent=useCallback(()=>{
  if(!agentId)return;
  Promise.all([
   api<{examples:TrainingExample[]}>(`/v1/tenants/${tenantId}/agents/${agentId}/training-examples`),
   api<{jobs:TrainingJob[]}>(`/v1/tenants/${tenantId}/agents/${agentId}/training-jobs`),
   api<TrainingDetail>(`/v1/tenants/${tenantId}/agents/${agentId}`),
  ]).then(([e,j,a])=>{setExamples(e.examples||[]);setJobs(j.jobs||[]);setAgent(a)}).catch(e=>setError(e.message));
 },[tenantId,agentId]);
 const loadSessions=()=>{
  if(!agentId||!selectedChannelId)return;
  api<{sessions:TrainingSession[];capability:TrainingCapability}>(`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions${qs({channelAccountId:selectedChannelId})}`)
   .then(data=>{setSessions(data.sessions||[]);setCapability({channelId:selectedChannelId,value:data.capability})})
   .catch(e=>setError(e.message));
 };
 useEffect(()=>{loadAgent()},[loadAgent]);
 useEffect(()=>{
  if(!agentId||!selectedChannelId)return;
  const poll=()=>api<{sessions:TrainingSession[];capability:TrainingCapability}>(`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions${qs({channelAccountId:selectedChannelId})}`)
   .then(data=>{setSessions(data.sessions||[]);setCapability({channelId:selectedChannelId,value:data.capability})})
   .catch(e=>setError(e.message));
  void poll();
  const timer=setInterval(()=>{void poll()},10000);
  return()=>clearInterval(timer);
 },[tenantId,agentId,selectedChannelId]);
 useEffect(()=>{if(!jobs.some(j=>["queued","running"].includes(j.status)))return;const timer=setInterval(loadAgent,5000);return()=>clearInterval(timer)},[jobs,loadAgent]);
 const currentCapability=capability?.channelId===selectedChannelId?capability.value:null;
 const visibleSessions=sessions.filter(s=>s.channel_account_id===selectedChannelId);
 const activeSession=visibleSessions.find(s=>s.status==="open");
 const activeSessionId=activeSession?.id;
 const finalizingSession=visibleSessions[0]?.status==="finalizing"?visibleSessions[0]:null;
 const failedSession=visibleSessions[0]?.status==="failed"?visibleSessions[0]:null;
 useEffect(()=>{if(!activeSessionId)return;const timer=setInterval(loadAgent,5000);return()=>clearInterval(timer)},[activeSessionId,loadAgent]);
 async function toggleTraining(){
  if(!agentId||!selectedChannelId)return;
  setError("");setNotice("");setBusy(true);
  try{
   if(activeSession){
    const result=await api<{trainingJobId:string|null}>(`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions/${activeSession.id}/stop`,{method:"POST",body:"{}"});
    setNotice(result.trainingJobId?"Training is off and AI has resumed. An automatic prompt update has started.":"Training is off. No approved example was captured in this session, so the published prompt is unchanged.");
   }else{
    await api(`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions`,{method:"POST",body:JSON.stringify({channelAccountId:selectedChannelId})});
    setNotice("Training is on. AI replies and automated follow-ups are paused for this channel.");
   }
   loadSessions();loadAgent();
  }catch(e){setError(e instanceof Error?e.message:"Training mode could not be changed.")}finally{setBusy(false)}
 }
 async function retryTraining(sessionId:string){
  if(!agentId)return;
  setError("");setNotice("");setBusy(true);
  try{
   await api(`/v1/tenants/${tenantId}/agents/${agentId}/training-sessions/${sessionId}/retry`,{method:"POST",body:"{}"});
   setNotice("Training update restarted. AI continues with its published prompt.");
   loadSessions();loadAgent();
  }catch(e){setError(e instanceof Error?e.message:"Training update could not be retried.")}finally{setBusy(false)}
 }
 async function add(e:FormEvent){e.preventDefault();setError("");try{await api(`/v1/tenants/${tenantId}/agents/${agentId}/training-examples`,{method:"POST",body:JSON.stringify(form)});setForm({inputText:"",idealResponse:""});loadAgent()}catch(reason){setError(reason instanceof Error?reason.message:"Could not save example")}}
 async function review(id:string,approvalStatus:"approved"|"rejected"){try{await api(`/v1/tenants/${tenantId}/agents/${agentId}/training-examples/${id}`,{method:"PATCH",body:JSON.stringify({approvalStatus})});loadAgent()}catch(e){setError(e instanceof Error?e.message:"Could not review example")}}
 async function train(){try{await api(`/v1/tenants/${tenantId}/agents/${agentId}/training-jobs`,{method:"POST",body:JSON.stringify({publishPolicy:"manual"})});loadAgent()}catch(e){setError(e instanceof Error?e.message:"Could not generate candidate")}}
 async function publish(promptId:string){try{await api(`/v1/tenants/${tenantId}/agents/${agentId}/prompts/${promptId}/publish`,{method:"POST",body:"{}"});loadAgent()}catch(e){setError(e instanceof Error?e.message:"Could not publish candidate")}}
 async function discard(promptId:string){try{await api(`/v1/tenants/${tenantId}/agents/${agentId}/prompts/${promptId}/discard`,{method:"POST",body:"{}"});loadAgent()}catch(e){setError(e instanceof Error?e.message:"Could not discard candidate")}}
 async function runCandidate(promptId:string){try{const result=await api<{response:string}>(`/v1/tenants/${tenantId}/agents/${agentId}/test`,{method:"POST",body:JSON.stringify({message:testMessage,promptVersionId:promptId})});setTestResult({promptId,...result})}catch(e){setError(e instanceof Error?e.message:"Could not test candidate")}}
 const activePrompt=agent?.prompts?.find(p=>p.id===agent?.agent?.active_prompt_version_id);
 const candidates=(agent?.prompts||[]).filter(p=>["candidate","draft"].includes(p.status));
 return <>
  <SectionHeader title="Training Studio" description="Choose an agent and its assigned channel. Training ON captures matching customer messages and eligible replies; Training OFF automatically updates the published prompt using approved examples from this and earlier retained sessions." action={<select aria-label="Agent" value={agentId} onChange={e=>{setAgentId(e.target.value);setNotice("");setError("")}}><option value="">Select agent</option>{agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>}/>
  {error&&<div className="alert error" role="alert">{error}</div>}
  {notice&&<div className="alert success" role="status">{notice}</div>}
  {!agentId?<Empty>Create or select an agent first.</Empty>:<>
   <div className="panel stack">
    <h3>Channel training</h3>
    <Field label="Channel"><select value={selectedChannelId} onChange={e=>{setChannelId(e.target.value);setNotice("");setError("")}}><option value="">Select assigned channel</option>{eligibleChannels.map(ch=><option key={ch.id} value={ch.id}>{ch.name} · {ch.platform}</option>)}</select></Field>
    {!eligibleChannels.length&&<p className="muted">Select this agent on a channel from AI Agents before starting channel training.</p>}
    {selectedChannelId&&<><p className="muted" aria-live="polite">{activeSession?"Training is ON. AI replies and automated follow-ups are paused for this channel. Matching customer messages and eligible replies are captured.":finalizingSession?"Training is OFF. AI has resumed with the previous published prompt while a new prompt is prepared for automatic publication.":failedSession?"Training is OFF. The update failed, and AI is using the previous published prompt.":"Training is OFF. The published agent handles eligible conversations."}</p>
     {currentCapability&&!currentCapability.supported&&<div className="alert">Training unavailable: {currentCapability.reason}</div>}
     {currentCapability?.supported&&<small className="muted">Eligible replies: successful Customer Panel HUMAN replies{currentCapability.source==="facebook_page_inbox"?" and verified Facebook Page Inbox echoes":""}. {currentCapability.reason}</small>}
     {currentCapability?.source==="facebook_page_inbox"&&<small className="muted">Page Inbox echoes do not prove a person typed the reply. Disable Inbox automations during training and review captured examples before turning training off.</small>}
     <div className="row"><Badge tone={failedSession?"bad":activeSession||finalizingSession?"warn":"good"}>{activeSession?"Training ON":finalizingSession?"Updating agent":failedSession?"Update failed":"Training OFF"}</Badge><button className={activeSession?"button danger":"button primary"} disabled={busy||Boolean(finalizingSession)||(!activeSession&&!currentCapability?.supported)} aria-pressed={Boolean(activeSession)} onClick={()=>void toggleTraining()}>{busy?"Saving…":activeSession?"Turn training off and update":finalizingSession?"Updating…":"Turn training on"}</button></div>
     {activeSession&&<small>{activeSession.captured_count||0} messages captured · {activeSession.example_count||0} examples · started {date(activeSession.created_at)}</small>}
     {failedSession&&<div className="alert error" role="alert">The latest training update failed. AI is using the previous published prompt. {failedSession.job_error||"Review the synthesis job and try again."} <button className="button ghost smallbtn" disabled={busy} onClick={()=>void retryTraining(failedSession.id)}>Retry update</button></div>}
     {visibleSessions.filter(s=>s.status!=="open").slice(0,5).map(s=><div className="list-row" key={s.id}><div><strong>Session {date(s.created_at)}</strong><span>{s.captured_count||0} messages · {s.example_count||0} examples</span></div><Badge tone={s.status==="finalizing"?"warn":s.status==="failed"||s.job_status==="failed"?"bad":s.job_status==="completed"?"good":"neutral"}>{s.status==="finalizing"?"updating":s.status==="failed"?"failed":s.job_status||s.status}</Badge></div>)}
    </>}
   </div>
   <div className="panel top-gap"><h3>Session examples for this agent</h3><p className="muted">Review captured examples before turning training off. Approved examples from earlier retained sessions are reused.</p>{examples.filter(e=>e.source==="native_channel_training").map(e=><div className="training-example" key={e.id}><div className="row-title"><small>{e.approval_status}</small><div className="row">{e.approval_status!=="approved"&&<button className="button ghost smallbtn" onClick={()=>void review(e.id,"approved")}>Approve</button>}{e.approval_status!=="rejected"&&<button className="button ghost smallbtn" onClick={()=>void review(e.id,"rejected")}>Reject</button>}</div></div><p><b>Customer:</b> {e.input_text}</p><p><b>Human reply:</b> {e.ideal_response}</p></div>)}{!examples.some(e=>e.source==="native_channel_training")&&<Empty>No messages have been paired in a training session yet.</Empty>}</div>
   <details className="panel top-gap"><summary>Advanced manual training tools</summary><p className="muted">Manual examples and prompt candidates are optional. The ON/OFF session publishes a successful update automatically; it does not require these controls.</p><form className="stack top-gap" onSubmit={add}><h3>Optional manual example</h3><Field label="Customer message"><textarea required rows={4} value={form.inputText} onChange={e=>setForm({...form,inputText:e.target.value})}/></Field><Field label="Ideal reply"><textarea required rows={5} value={form.idealResponse} onChange={e=>setForm({...form,idealResponse:e.target.value})}/></Field><button className="button primary">Save approved example</button></form><div className="top-gap"><button className="button ghost smallbtn" disabled={!examples.some(e=>e.approval_status==="approved")} onClick={()=>void train()}>Generate manual candidate</button></div>{candidates.map(p=><div className="training-example" key={p.id}><div className="row-title"><strong>Prompt v{p.version}</strong><div className="row"><button className="button ghost smallbtn" onClick={()=>void runCandidate(p.id)}>Test</button><button className="button primary smallbtn" onClick={()=>void publish(p.id)}>Publish</button><button className="button ghost smallbtn" onClick={()=>void discard(p.id)}>Discard</button></div></div><div className="two-col top-gap"><div><small>Current active {activePrompt?`v${activePrompt.version}`:"none"}</small><pre className="result-box">{activePrompt?.assembled_prompt||"No active prompt"}</pre></div><div><small>Candidate v{p.version}</small><pre className="result-box">{p.assembled_prompt}</pre></div></div><Field label="Sandbox customer message"><textarea rows={3} value={testMessage} onChange={e=>setTestMessage(e.target.value)}/></Field>{testResult&&testResult.promptId===p.id&&<div className="result-box"><b>Candidate response</b><p>{testResult.response}</p></div>}</div>)}<h3>Prompt history</h3>{(agent?.prompts||[]).map(p=><div className="list-row" key={p.id}><div><strong>v{p.version}</strong><span>{p.source} · {p.status} · {date(p.created_at)}</span></div>{p.id!==agent?.agent?.active_prompt_version_id&&p.status!=="rejected"&&<button className="button ghost smallbtn" onClick={()=>void publish(p.id)}>Make active</button>}</div>)}<h3>Recent synthesis jobs</h3>{jobs.map(j=><div className="list-row" key={j.id}><span>{date(j.created_at)}{j.error?` · ${j.error}`:""}</span><Badge tone={j.status==="completed"?"good":j.status==="failed"?"bad":"warn"}>{j.status}</Badge></div>)}{!jobs.length&&<Empty>No synthesis job has run yet.</Empty>}</details>
  </>}
 </>;
}
function Knowledge({tenantId,businessId,role}:{tenantId:string;businessId:string;role?:string}){
 const confirmAction=useConfirmAction();
 const canManage=["OWNER","ADMIN","STAFF"].includes(role||"");
 const [rows,setRows]=useState<any[]>([]);
 const [open,setOpen]=useState(false);
 const [editing,setEditing]=useState<any>(null);
 const [form,setForm]=useState({type:"faq",title:"",content:""});
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const load=useCallback(async()=>{
  if(!tenantId){setRows([]);return;}
  const response=await api<any>("/v1/tenants/"+tenantId+"/knowledge"+qs({businessId}));
  setRows((response.sources||[]).filter((source:any)=>source.status!=="archived"));
 },[tenantId,businessId]);
 useEffect(()=>{void load().catch(reason=>setError(reason instanceof Error?reason.message:"Unable to load knowledge."));},[load]);
 function startCreate(){setEditing(null);setForm({type:"faq",title:"",content:""});setError("");setOpen(true)}
 function startEdit(source:any){setEditing(source);setForm({type:source.type,title:source.title,content:source.content||""});setError("");setOpen(true)}
 async function submit(event:FormEvent){
  event.preventDefault();setBusy(true);setError("");setNotice("");
  try{
   if(editing) await api("/v1/tenants/"+tenantId+"/knowledge/"+editing.id,{method:"PATCH",body:JSON.stringify({title:form.title,content:form.content})});
   else await api("/v1/tenants/"+tenantId+"/knowledge",{method:"POST",body:JSON.stringify({businessId,...form})});
   setOpen(false);setEditing(null);setNotice(editing?"Knowledge source updated and re-indexing started.":"Knowledge source saved for indexing.");await load();
  }catch(reason){setError(reason instanceof Error?reason.message:"Unable to save knowledge source.")}
  finally{setBusy(false)}
 }
 async function remove(source:any){
  if(!await confirmAction({title:`Delete ${source.title}?`,description:"This knowledge source will be removed from AI retrieval. Historical records remain."}))return;
  setBusy(true);setError("");setNotice("");
  try{await api("/v1/tenants/"+tenantId+"/knowledge/"+source.id,{method:"DELETE"});setNotice("Knowledge source deleted.");await load()}
  catch(reason){setError(reason instanceof Error?reason.message:"Unable to delete knowledge source.")}
  finally{setBusy(false)}
 }
 return <>
  <SectionHeader title="Knowledge & RAG" description="Policies, FAQs, documents and approved answers are asynchronously indexed into tenant-scoped pgvector retrieval." action={canManage?<button className="button primary" disabled={!businessId} onClick={startCreate}>+ Knowledge source</button>:undefined}/>
  {error&&<div role="alert" className="alert error">{error}</div>}
  {notice&&<div role="status" className="alert success">{notice}</div>}
  <div className="grid-list">{rows.map(source=><div className="entity-card" key={source.id}><div className="entity-icon">K</div><div className="grow"><div className="row-title"><strong>{source.title}</strong><Badge tone={source.status==="ready"?"good":source.status==="error"?"bad":"warn"}>{source.status}</Badge></div><p>{source.type} · v{source.source_version} · {source.chunk_count} chunks</p></div>{canManage&&<div className="row"><button className="button ghost smallbtn" onClick={()=>startEdit(source)}>Edit</button><button className="button danger smallbtn" disabled={busy} onClick={()=>void remove(source)}>Delete</button></div>}</div>)}{!rows.length&&<Empty>No indexed knowledge yet.</Empty>}</div>
  {open&&<Modal title={editing?"Edit knowledge source":"Add knowledge source"} onClose={()=>!busy&&setOpen(false)}><form className="stack" onSubmit={submit}>
   <Field label="Type"><select disabled={Boolean(editing)} value={form.type} onChange={event=>setForm({...form,type:event.target.value})}><option value="faq">FAQ</option><option value="policy">Policy</option><option value="document">Document text</option><option value="approved_answer">Approved answer</option><option value="custom">Custom</option></select></Field>
   <Field label="Title"><input required value={form.title} onChange={event=>setForm({...form,title:event.target.value})}/></Field>
   <Field label="Content"><textarea required rows={12} value={form.content} onChange={event=>setForm({...form,content:event.target.value})}/></Field>
   {error&&<div role="alert" className="alert error">{error}</div>}
   <button className="button primary" disabled={busy}>{busy?"Saving…":editing?"Save and re-index":"Save and index"}</button>
  </form></Modal>}
 </>;
}

function Media({tenantId,businessId}:{tenantId:string;businessId:string}){
 const confirmAction=useConfirmAction();
 const [rows,setRows]=useState<any[]>([]);const [storage,setStorage]=useState<any>(null);const [uploading,setUploading]=useState(false);const[error,setError]=useState("");const[deleteGuidanceAssetId,setDeleteGuidanceAssetId]=useState("");
 const load=useCallback(()=>{if(!tenantId)return;Promise.all([api<any>(`/v1/tenants/${tenantId}/media${qs({businessId})}`),api<any>(`/v1/tenants/${tenantId}/media/limits`)]).then(([m,q])=>{setRows(m.assets||[]);setStorage({used_bytes:q.usage.storageBytes,available_bytes:q.remaining.storageBytes,quota_bytes:q.limits.mediaStorageBytes})}).catch(e=>setError(e.message))},[tenantId,businessId]);useEffect(()=>{load();},[load]);
 async function upload(e:React.ChangeEvent<HTMLInputElement>){const file=e.target.files?.[0];if(!file)return;setUploading(true);setError("");try{const fd=new FormData();fd.set("file",file);fd.set("visibility","private");await api(`/v1/tenants/${tenantId}/media`,{method:"POST",headers:businessId?{"x-business-id":businessId}:{},body:fd});load()}catch(e){setError(e instanceof Error?e.message:"Upload failed")}finally{setUploading(false);e.target.value=""}}
 async function setVisibility(asset:any,visibility:"private"|"public"){await api(`/v1/tenants/${tenantId}/media/${asset.id}/visibility`,{method:"PATCH",body:JSON.stringify({visibility})});load()}
 async function remove(asset:any){if(Number(asset.reference_count||0)>0){setDeleteGuidanceAssetId(asset.id);return;}if(!await confirmAction({title:"Delete this media file?",description:"This file is not linked to any record and will be permanently removed from storage."}))return;setDeleteGuidanceAssetId("");setError("");try{await api(`/v1/tenants/${tenantId}/media/${asset.id}`,{method:"DELETE"});load()}catch(e){setError(e instanceof Error?e.message:"Delete failed")}}
 return <><SectionHeader title="Media library" description="Files are private by default. Your workspace shares the app's Media Storage service and has a 512 MB maximum. Publish only catalog assets that need provider-accessible URLs." action={<label className="button primary file-button">{uploading?"Uploading…":"+ Upload private file"}<input type="file" accept="image/*,video/*,audio/*,application/pdf" onChange={upload} disabled={uploading}/></label>}/>{error&&<div className="alert error" role="alert">{error}</div>}{storage&&<div className="metric-grid compact-metrics"><Card title="Used storage" value={`${(Number(storage.used_bytes||0)/1024/1024).toFixed(1)} MB`}/><Card title="Available" value={`${(Number(storage.available_bytes||0)/1024/1024).toFixed(1)} MB`}/></div>}<div className="media-grid">{rows.map(m=><div className="media-card" key={m.id}>{m.mime_type?.startsWith("image/")?<Image src={m.public_url||`${API_URL}/v1/tenants/${tenantId}/media/${m.id}/content`} alt={m.original_name||"media"} width={320} height={190} sizes="(max-width: 700px) 90vw, 320px" unoptimized/>:<div className="file-placeholder">{(m.kind||"FILE").toUpperCase()}</div>}<strong>{m.original_name||m.id}</strong><span>{(Number(m.size_bytes)/1024).toFixed(1)} KB · {m.visibility}</span><small>{m.reference_count||0} references</small><div className="row"><button className="button ghost smallbtn" disabled={uploading} onClick={()=>void setVisibility(m,m.visibility==="public"?"private":"public")}>{m.visibility==="public"?"Make private":"Publish"}</button><button className="button danger smallbtn" disabled={uploading} title={Number(m.reference_count||0)>0?"Open deletion guidance for linked media":"Delete this file"} onClick={()=>void remove(m)}>Delete</button></div>{deleteGuidanceAssetId===m.id&&Number(m.reference_count||0)>0&&<div className="media-delete-guidance" role="status">This file is linked to {m.reference_count} record(s), so it cannot be deleted yet. Remove catalog links first; conversation media is retained for history. <Link href="/catalogs">Open Data / Catalogs →</Link></div>}</div>)}{!rows.length&&<Empty>Upload reusable product/service media or private conversation documents.</Empty>}</div></>;
}
function Analytics({tenantId,businessId}:{tenantId:string;businessId:string}){
 const [data,setData]=useState<any>(null);useEffect(()=>{if(tenantId)api<any>(`/v1/tenants/${tenantId}/analytics/overview${qs({businessId})}`).then(setData)},[tenantId,businessId]);if(!data)return <Loading/>;return <><SectionHeader title="Usage & channel analytics" description="Message transports, logical AI turns, media operations and business outcomes are tracked as separate units."/><div className="metric-grid">{Object.entries(data.metrics||{}).map(([key,value]:any)=><Card key={key} title={key.replace(/_/g," ")} value={fmt(value.quantity)} note={value.estimatedCost?`Est. $${Number(value.estimatedCost).toFixed(4)}`:undefined}/>)}</div><div className="panel top-gap"><h3>Per-channel transactions</h3><div className="table-wrap borderless"><table><thead><tr><th>Channel</th><th>Inbound</th><th>Outbound</th><th>Conversations</th></tr></thead><tbody>{data.channels?.map((c:any)=><tr key={c.id}><td><strong>{c.name}</strong><small>{c.platform}</small></td><td>{fmt(c.inbound_messages)}</td><td>{fmt(c.outbound_messages)}</td><td>{fmt(c.conversations)}</td></tr>)}</tbody></table></div></div></>;
}

function Team({tenantId,role,userId}:{tenantId:string;role?:string;userId:string}){
 const canManage=role==="OWNER"||role==="ADMIN";
 const [rows,setRows]=useState<any[]>([]);const[invitations,setInvitations]=useState<any[]>([]);const[businesses,setBusinesses]=useState<any[]>([]);const[open,setOpen]=useState(false);const[error,setError]=useState("");const[notice,setNotice]=useState("");
 const [form,setForm]=useState({email:"",role:"STAFF",businessScope:[] as string[]});
 const [editingScope,setEditingScope]=useState<any|null>(null);const[scopeMode,setScopeMode]=useState<"all"|"selected">("all");const[scopeSelection,setScopeSelection]=useState<string[]>([]);const[scopeBusy,setScopeBusy]=useState(false);
 const load=useCallback(()=>{if(!tenantId||!canManage)return;Promise.all([api<any>("/v1/tenants/"+tenantId+"/members"),api<any>("/v1/tenants/"+tenantId+"/invitations"),api<any>("/v1/tenants/"+tenantId+"/businesses")]).then(([m,i,b])=>{setRows(m.members||[]);setInvitations(i.invitations||[]);setBusinesses(b.businesses||[])}).catch(e=>setError(e instanceof Error?e.message:"Unable to load team."))},[tenantId,canManage]);useEffect(()=>{load()},[load]);
 const ownScope=rows.find(m=>m.user_id===userId)?.business_scope;
 const canGrantAll=role==="OWNER"||ownScope===null;
 const scopeBusinesses=Array.isArray(ownScope)?businesses.filter(b=>ownScope.includes(b.id)):businesses;
 const canEditScope=(member:any)=>member.role!=="OWNER"&&canManage&&(canGrantAll||(Array.isArray(ownScope)&&Array.isArray(member.business_scope)&&member.business_scope.length>0&&member.business_scope.every((id:string)=>ownScope.includes(id))));
 async function invite(e:FormEvent){e.preventDefault();if(!canManage)return;if(!canGrantAll&&!form.businessScope.length){setError("Select at least one business for this invitation.");return;}setError("");setNotice("");try{await api("/v1/tenants/"+tenantId+"/invitations",{method:"POST",body:JSON.stringify({email:form.email,role:form.role,businessScope:form.businessScope.length?form.businessScope:null})});setForm({email:"",role:"STAFF",businessScope:[]});setOpen(false);setNotice("Invitation sent.");load()}catch(e){setError(e instanceof Error?e.message:"Invite failed")}}
 async function updateMember(member:any,patch:any){setError("");try{await api("/v1/tenants/"+tenantId+"/members/"+member.user_id,{method:"PATCH",body:JSON.stringify(patch)});load()}catch(e){setError(e instanceof Error?e.message:"Unable to update member.")}}
 async function revoke(id:string){setError("");try{await api("/v1/tenants/"+tenantId+"/invitations/"+id,{method:"DELETE"});load()}catch(e){setError(e instanceof Error?e.message:"Unable to revoke invitation.")}}
 function startScopeEdit(member:any){if(!canEditScope(member))return;setEditingScope(member);setScopeMode(member.business_scope===null?"all":"selected");setScopeSelection(Array.isArray(member.business_scope)?member.business_scope.filter((id:string)=>scopeBusinesses.some(b=>b.id===id)):[]);setError("");setNotice("")}
 async function saveScope(e:FormEvent){e.preventDefault();if(!editingScope||!canEditScope(editingScope))return;if(scopeMode==="all"&&!canGrantAll){setError("Your role cannot grant access to all businesses.");return;}if(scopeMode==="selected"&&!scopeSelection.length){setError("Select at least one business.");return;}setScopeBusy(true);setError("");try{await api("/v1/tenants/"+tenantId+"/members/"+editingScope.user_id,{method:"PATCH",body:JSON.stringify({businessScope:scopeMode==="all"?null:scopeSelection})});setEditingScope(null);setNotice("Business access updated.");load()}catch(e){setError(e instanceof Error?e.message:"Unable to update business access.")}finally{setScopeBusy(false)}}
 if(!canManage)return <><SectionHeader title="Team & access" description="Only workspace owners and administrators can manage team access."/></>;
 return <><SectionHeader title="Team & access" description="Invite teammates, assign tenant roles, and optionally restrict non-owner users to selected businesses." action={<button className="button primary" onClick={()=>setOpen(true)}>+ Invite member</button>}/>{error&&<div className="alert error" role="alert">{error}</div>}{notice&&<div className="alert success" role="status">{notice}</div>}<div className="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Business scope</th><th>Status</th><th>Last login</th><th/></tr></thead><tbody>{rows.map(m=><tr key={m.user_id}><td><strong>{m.name||m.email}</strong><small>{m.email}</small></td><td><select value={m.role} disabled={m.role==="OWNER"||!canEditScope(m)} onChange={e=>void updateMember(m,{role:e.target.value})}>{m.role==="OWNER"&&<option>OWNER</option>}<option>ADMIN</option><option>STAFF</option><option>VIEWER</option></select></td><td><small>{m.role==="OWNER"?"All businesses":Array.isArray(m.business_scope)?m.business_scope.length?m.business_scope.map((id:string)=>businesses.find(b=>b.id===id)?.name||id).join(", "):"No businesses":"All businesses"}</small></td><td><Badge tone={m.status==="active"?"good":"warn"}>{m.status}</Badge></td><td>{date(m.last_login_at)}</td><td><div className="row">{canEditScope(m)&&<button className="button ghost smallbtn" onClick={()=>startScopeEdit(m)}>Edit access</button>}{canEditScope(m)&&<button className="button ghost smallbtn" onClick={()=>void updateMember(m,{status:m.status==="active"?"suspended":"active"})}>{m.status==="active"?"Suspend":"Reactivate"}</button>}</div></td></tr>)}</tbody></table></div><div className="panel top-gap"><h3>Invitations</h3>{invitations.map(i=><div className="list-row" key={i.id}><div><strong>{i.email}</strong><span>{i.role} · {i.status} · expires {date(i.expires_at)}</span></div>{i.status==="pending"&&<button className="button ghost smallbtn" onClick={()=>void revoke(i.id)}>Revoke</button>}</div>)}{!invitations.length&&<Empty>No invitations yet.</Empty>}</div>
 {open&&<Modal title="Invite teammate" onClose={()=>setOpen(false)}><form className="stack" onSubmit={invite}>{error&&<div className="alert error" role="alert">{error}</div>}<Field label="Email"><input type="email" required value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></Field><Field label="Role"><select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}><option value="ADMIN">Admin</option><option value="STAFF">Staff</option><option value="VIEWER">Viewer</option></select></Field><Field label="Business access" hint={canGrantAll?"Leave all unchecked for all businesses.":"Select at least one business within your access."}><div className="stack">{scopeBusinesses.map(b=><label className="row" key={b.id}><input type="checkbox" checked={form.businessScope.includes(b.id)} onChange={e=>setForm({...form,businessScope:e.target.checked?[...form.businessScope,b.id]:form.businessScope.filter(id=>id!==b.id)})}/><span>{b.name}</span></label>)}</div></Field><button className="button primary">Send invitation</button></form></Modal>}
 {editingScope&&<Modal title="Edit business access" onClose={()=>!scopeBusy&&setEditingScope(null)}><form className="stack" onSubmit={saveScope}><p className="muted">{editingScope.name||editingScope.email}</p>{error&&<div className="alert error" role="alert">{error}</div>}{canGrantAll&&<label className="row"><input type="radio" name="scope-mode" checked={scopeMode==="all"} onChange={()=>setScopeMode("all")}/>All businesses</label>}<label className="row"><input type="radio" name="scope-mode" checked={scopeMode==="selected"} onChange={()=>setScopeMode("selected")}/>Selected businesses</label>{scopeMode==="selected"&&<fieldset className="stack"><legend>Business access</legend><div className="stack">{scopeBusinesses.map(b=><label className="row" key={b.id}><input type="checkbox" checked={scopeSelection.includes(b.id)} onChange={e=>setScopeSelection(current=>e.target.checked?[...current,b.id]:current.filter(id=>id!==b.id))}/><span>{b.name}</span></label>)}</div></fieldset>}<button className="button primary" disabled={scopeBusy}>{scopeBusy?"Saving…":"Save business access"}</button></form></Modal>}</>;
}
function Settings({tenantId,role,currentBusiness,onChanged}:{tenantId:string;role?:string;currentBusiness:any;onChanged:()=>void}){
 const confirmAction=useConfirmAction();
 const [tenant,setTenant]=useState<any>(null);const[name,setName]=useState("");const[billing,setBilling]=useState<any>(null);const[retention,setRetention]=useState<any>({});const[dataRequests,setDataRequests]=useState<any[]>([]);const[policies,setPolicies]=useState<any[]>([]);const[alerts,setAlerts]=useState<any[]>([]);const[error,setError]=useState("");const[notice,setNotice]=useState("");
 const owner=role==="OWNER";
 const canEditPolicies=role==="OWNER"||role==="ADMIN"||role==="STAFF";const canDeletePolicies=role==="OWNER"||role==="ADMIN";
 const[policyForm,setPolicyForm]=useState({name:"General follow-up",delayMinutes:60,maxWindowHours:23,messageTemplate:"Just checking in—would you like any more help?"});const[editingPolicy,setEditingPolicy]=useState<any|null>(null);const[policyEdit,setPolicyEdit]=useState({name:"",delayMinutes:60,maxWindowHours:23,messageTemplate:""});const[policyBusy,setPolicyBusy]=useState(false);const[alertForm,setAlertForm]=useState({key:"aiTurnsPerMonth",thresholdPercent:80});const[deletingAlertId,setDeletingAlertId]=useState("");const[deletePassword,setDeletePassword]=useState("");
 const load=useCallback(()=>{if(!tenantId)return;Promise.all([api<any>(`/v1/tenants/${tenantId}`),api<any>(`/v1/tenants/${tenantId}/billing`).catch(()=>null),api<any>(`/v1/tenants/${tenantId}/retention`).catch(()=>null),api<any>(`/v1/tenants/${tenantId}/data-requests`).catch(()=>({requests:[]})),api<any>(`/v1/tenants/${tenantId}/quota-alerts`).catch(()=>({alerts:[]})),currentBusiness?api<any>(`/v1/tenants/${tenantId}/followup-policies${qs({businessId:currentBusiness.id})}`).catch(()=>({policies:[]})):Promise.resolve({policies:[]})]).then(([t,b,r,d,a,p])=>{setTenant(t.tenant);setName(t.tenant.name);setBilling(b);setRetention(r?.policy||{});setDataRequests(d.requests||[]);setAlerts(a.alerts||[]);setPolicies(p.policies||[])})},[tenantId,currentBusiness?.id]);useEffect(()=>{load()},[load]);
 async function save(){setError("");try{await api(`/v1/tenants/${tenantId}`,{method:"PATCH",body:JSON.stringify({name})});setNotice("Organization settings saved.");onChanged();load()}catch(e){setError(e instanceof Error?e.message:"Save failed")}}
 async function saveRetention(){if(!owner){setError("Only the tenant owner can change retention policy.");return;}setError("");try{await api(`/v1/tenants/${tenantId}/retention`,{method:"PUT",body:JSON.stringify({conversationDays:retention.conversation_days?Number(retention.conversation_days):null,mediaDays:retention.media_days?Number(retention.media_days):null,auditDays:retention.audit_days?Number(retention.audit_days):null,trainingDays:retention.training_days?Number(retention.training_days):null,hardDeleteAfterDays:retention.hard_delete_after_days?Number(retention.hard_delete_after_days):null})});setNotice("Retention policy saved.");load()}catch(e){setError(e instanceof Error?e.message:"Retention update failed")}}
 async function addPolicy(e:FormEvent){e.preventDefault();if(!currentBusiness||!canEditPolicies)return;setError("");setNotice("");try{await api(`/v1/tenants/${tenantId}/followup-policies`,{method:"POST",body:JSON.stringify({businessId:currentBusiness.id,...policyForm})});setNotice("Follow-up policy created.");load()}catch(e){setError(e instanceof Error?e.message:"Unable to create follow-up policy.")}}
 function startEditPolicy(policy:any){if(!canEditPolicies)return;setEditingPolicy(policy);setPolicyEdit({name:policy.name,delayMinutes:Number(policy.delay_minutes),maxWindowHours:Number(policy.max_window_hours),messageTemplate:policy.message_template});setError("");setNotice("")}
 async function savePolicy(e:FormEvent){e.preventDefault();if(!editingPolicy||!canEditPolicies)return;setPolicyBusy(true);setError("");try{await api(`/v1/tenants/${tenantId}/followup-policies/${editingPolicy.id}`,{method:"PATCH",body:JSON.stringify(policyEdit)});setEditingPolicy(null);setNotice("Follow-up policy updated.");load()}catch(e){setError(e instanceof Error?e.message:"Unable to update follow-up policy.")}finally{setPolicyBusy(false)}}
 async function togglePolicy(p:any){if(!canEditPolicies)return;setError("");try{await api(`/v1/tenants/${tenantId}/followup-policies/${p.id}`,{method:"PATCH",body:JSON.stringify({active:!p.active})});load()}catch(e){setError(e instanceof Error?e.message:"Unable to update follow-up policy.")}}
 async function deletePolicy(p:any){if(!canDeletePolicies)return;if(!await confirmAction({title:`Delete ${p.name}?`,description:"This follow-up policy will be removed from the selected business."}))return;setError("");try{await api(`/v1/tenants/${tenantId}/followup-policies/${p.id}`,{method:"DELETE"});setNotice("Follow-up policy deleted.");load()}catch(e){setError(e instanceof Error?e.message:"Unable to delete follow-up policy.")}}
 async function addAlert(e:FormEvent){e.preventDefault();if(!owner){setError("Only the tenant owner can manage quota alerts.");return;}setError("");try{await api(`/v1/tenants/${tenantId}/quota-alerts`,{method:"POST",body:JSON.stringify({...alertForm,channel:"in_app",recipients:[]})});setNotice("Quota alert saved.");load()}catch(e){setError(e instanceof Error?e.message:"Quota alert update failed")}}
 async function deleteAlert(alert:any){if(!owner){setError("Only the tenant owner can manage quota alerts.");return;}if(!await confirmAction({title:"Delete quota alert?",description:`Remove the ${alert.key} alert configured at ${alert.threshold_percent}%.`}))return;setDeletingAlertId(alert.id);setError("");setNotice("");try{await api(`/v1/tenants/${tenantId}/quota-alerts/${alert.id}`,{method:"DELETE"});setAlerts(current=>current.filter(item=>item.id!==alert.id));setNotice("Quota alert deleted.")}catch(e){setError(e instanceof Error?e.message:"Unable to delete quota alert.")}finally{setDeletingAlertId("")}}
 async function exportData(){if(!owner){setError("Only the tenant owner can request or download a workspace JSON export.");return;}setError("");try{const r=await api<any>(`/v1/tenants/${tenantId}/export`,{method:"POST",body:"{}"});setNotice(`JSON export queued: ${r.request.id}. It includes workspace records and media metadata, not media file contents.`);load()}catch(reason){setError(reason instanceof Error?reason.message:"Unable to queue JSON export.")}}
 async function requestDelete(){if(!owner){setError("Only the tenant owner can request workspace deletion.");return;}if(!tenant?.slug||!deletePassword)return;if(!await confirmAction({title:`Request deletion for ${tenant.name}?`,description:"This will suspend the workspace and queue tenant deletion. You will need your password and workspace slug to complete the request.",confirmLabel:"Queue deletion"}))return;try{const r=await api<any>(`/v1/tenants/${tenantId}/delete-request`,{method:"POST",body:JSON.stringify({confirmation:tenant.slug,password:deletePassword})});setNotice(`Deletion queued: ${r.request.id}`);setDeletePassword("");load()}catch(e){setError(e instanceof Error?e.message:"Deletion request failed")}}
 return <><SectionHeader title="Workspace settings" description="Organization, plan, follow-up policy, quotas, retention and data-rights controls. Infrastructure secrets remain server-side."/>{error&&<div className="alert error">{error}</div>}{notice&&<div className="alert success">{notice}</div>}<div className="two-col"><div className="panel stack"><h3>Organization</h3><Field label="Name"><input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="Plan"><input disabled value={tenant?.plan_name||tenant?.plan_key||"Free"}/></Field><button className="button primary" onClick={save}>Save organization</button></div><div className="panel"><h3>Selected business</h3>{currentBusiness?<div className="detail-list"><div><span>Name</span><b>{currentBusiness.name}</b></div><div><span>Timezone</span><b>{currentBusiness.timezone}</b></div><div><span>Currency</span><b>{currentBusiness.currency}</b></div><div><span>Status</span><Badge tone={currentBusiness.status==="active"?"good":"warn"}>{currentBusiness.status}</Badge></div></div>:<Empty>Select a business for business-scoped automation settings.</Empty>}</div></div><div className="two-col top-gap"><div className="panel"><h3>Billing & plan readiness</h3><div className="detail-list"><div><span>Plan</span><b>{billing?.tenant?.plan_name||tenant?.plan_name||"—"}</b></div><div><span>Subscription</span><b>{billing?.subscription?.status||"Not connected to a payment provider"}</b></div><div><span>Current period</span><b>{billing?.subscription?.current_period_end?date(billing.subscription.current_period_end):"—"}</b></div></div><h4>Plan prices</h4>{(billing?.prices||[]).map((p:any)=><div className="list-row" key={p.id}><div><strong>{p.billing_interval}</strong><span>{p.provider||"manual"}{p.external_price_id?` · ${p.external_price_id}`:""}</span></div><b>{p.currency} {Number(p.unit_amount||0).toFixed(2)}</b></div>)}{!billing?.prices?.length&&<p className="muted">No price metadata configured for this plan yet.</p>}<h4>Credits</h4>{(billing?.credits||[]).slice(0,5).map((cr:any)=><div className="list-row" key={cr.id}><div><strong>{cr.reason||"Account credit"}</strong><span>{date(cr.created_at)}{cr.expires_at?` · expires ${date(cr.expires_at)}`:""}</span></div><b>{cr.currency} {Number(cr.amount||0).toFixed(2)}</b></div>)}{!billing?.credits?.length&&<p className="muted">No credits.</p>}<h4>Invoice / payment history</h4>{(billing?.invoices||[]).slice(0,10).map((inv:any)=><div className="list-row" key={inv.id}><div><strong>{inv.external_invoice_id||inv.id.slice(0,8)}</strong><span>{inv.status} · {date(inv.issued_at||inv.created_at)}</span>{inv.hosted_url&&<a href={inv.hosted_url} target="_blank" rel="noreferrer">Open invoice</a>}</div><b>{inv.currency} {Number(inv.amount_paid||0).toFixed(2)} / {Number(inv.amount_due||0).toFixed(2)}</b></div>)}{!billing?.invoices?.length&&<p className="muted">No invoices recorded.</p>}</div><div className="panel stack"><h3>Retention</h3><p className="muted">{owner?"Tenant owner controls retention policy.":"Only the tenant owner can change retention policy."}</p><div className="form-grid"><Field label="Conversation days"><input disabled={!owner} type="number" min={1} value={retention.conversation_days??""} onChange={e=>setRetention({...retention,conversation_days:e.target.value})}/></Field><Field label="Media days"><input disabled={!owner} type="number" min={1} value={retention.media_days??""} onChange={e=>setRetention({...retention,media_days:e.target.value})}/></Field><Field label="Training days"><input disabled={!owner} type="number" min={1} value={retention.training_days??""} onChange={e=>setRetention({...retention,training_days:e.target.value})}/></Field><Field label="Audit days"><input disabled={!owner} type="number" min={30} value={retention.audit_days??""} onChange={e=>setRetention({...retention,audit_days:e.target.value})}/></Field></div><button className="button" disabled={!owner} onClick={saveRetention}>Save retention policy</button></div></div><div className="two-col top-gap"><div className="panel"><h3>Follow-up policies</h3>{currentBusiness?<>{canEditPolicies&&<form className="stack" onSubmit={addPolicy}><Field label="Policy name"><input required value={policyForm.name} onChange={e=>setPolicyForm({...policyForm,name:e.target.value})}/></Field><div className="form-grid"><Field label="Delay minutes"><input type="number" min={1} value={policyForm.delayMinutes} onChange={e=>setPolicyForm({...policyForm,delayMinutes:Number(e.target.value)})}/></Field><Field label="Provider window hours"><input type="number" min={1} max={72} value={policyForm.maxWindowHours} onChange={e=>setPolicyForm({...policyForm,maxWindowHours:Number(e.target.value)})}/></Field></div><Field label="Message"><textarea required rows={3} value={policyForm.messageTemplate} onChange={e=>setPolicyForm({...policyForm,messageTemplate:e.target.value})}/></Field><button className="button primary">Create policy</button></form>}{policies.map(p=><div className="list-row" key={p.id}><div><strong>{p.name}</strong><span>{p.delay_minutes} min · window {p.max_window_hours}h</span></div><div className="row">{canEditPolicies&&<><button className="button ghost smallbtn" onClick={()=>startEditPolicy(p)}>Edit</button><button className="button ghost smallbtn" onClick={()=>void togglePolicy(p)}>{p.active?"Pause":"Enable"}</button></>}{canDeletePolicies&&<button className="button danger smallbtn" onClick={()=>void deletePolicy(p)}>Delete</button>}</div></div>)}</>:<Empty>Select a business first.</Empty>}</div><div className="panel"><h3>Quota alerts</h3><p className="muted">{owner?"Tenant owner controls quota alerts.":"Only the tenant owner can manage quota alerts."}</p><form className="stack" onSubmit={addAlert}><Field label="Limit key"><input disabled={!owner} required value={alertForm.key} onChange={e=>setAlertForm({...alertForm,key:e.target.value})}/></Field><Field label="Threshold %"><input disabled={!owner} type="number" min={1} max={100} value={alertForm.thresholdPercent} onChange={e=>setAlertForm({...alertForm,thresholdPercent:Number(e.target.value)})}/></Field><button disabled={!owner} className="button">Add in-app alert</button></form>{alerts.map(a=><div className="list-row" key={a.id}><div><strong>{a.key}</strong><span>{a.threshold_percent}% · {a.channel}</span></div><div className="row"><Badge tone={a.active?"good":"neutral"}>{a.active?"active":"disabled"}</Badge>{owner&&<button className="button danger smallbtn" type="button" aria-label={`Delete quota alert ${a.key} at ${a.threshold_percent}%`} disabled={Boolean(deletingAlertId)} onClick={()=>void deleteAlert(a)}>{deletingAlertId===a.id?"Deleting…":"Delete"}</button>}</div></div>)}</div></div><div className="panel top-gap"><h3>Data export & deletion</h3><p className="muted">Exports are generated asynchronously as private Media Storage files. Tenant deletion requires owner password reauthentication and starts by suspending automation.</p><div className="row"><button disabled={!owner} className="button" onClick={exportData}>Request export</button><input disabled={!owner} type="password" placeholder="Password for deletion" value={deletePassword} onChange={e=>setDeletePassword(e.target.value)}/><button className="button danger" disabled={!owner||!deletePassword} onClick={requestDelete}>Request tenant deletion</button></div>{dataRequests.map(r=><div className="list-row" key={r.id}><div><strong>{r.type}</strong><span>{r.status} · {date(r.requested_at)}</span></div><div className="row"><Badge tone={r.status==="completed"?"good":r.status==="failed"?"bad":"warn"}>{r.job_status||r.status}</Badge>{r.type==="export"&&r.status==="completed"&&<a className="button ghost smallbtn" href={`${API_URL}/v1/tenants/${tenantId}/data-requests/${r.id}/download`}>Download export</a>}</div></div>)}</div><>{editingPolicy&&<Modal title="Edit follow-up policy" onClose={()=>!policyBusy&&setEditingPolicy(null)}><form className="stack" onSubmit={savePolicy}>{error&&<div className="alert error" role="alert">{error}</div>}<Field label="Policy name"><input required maxLength={160} value={policyEdit.name} onChange={e=>setPolicyEdit({...policyEdit,name:e.target.value})}/></Field><div className="form-grid"><Field label="Delay minutes"><input required type="number" min={1} max={43200} value={policyEdit.delayMinutes} onChange={e=>setPolicyEdit({...policyEdit,delayMinutes:Number(e.target.value)})}/></Field><Field label="Provider window hours"><input required type="number" min={1} max={72} value={policyEdit.maxWindowHours} onChange={e=>setPolicyEdit({...policyEdit,maxWindowHours:Number(e.target.value)})}/></Field></div><Field label="Message"><textarea required maxLength={5000} rows={4} value={policyEdit.messageTemplate} onChange={e=>setPolicyEdit({...policyEdit,messageTemplate:e.target.value})}/></Field><button className="button primary" disabled={policyBusy}>{policyBusy?"Saving…":"Save policy"}</button></form></Modal>}</></>;
}
function Loading(){return <div className="screen-center inline"><div className="spinner"/>Loading…</div>}
