"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import AdminAccessGuard from "../../components/AdminAccessGuard";

type Provider={id:string;name:string;provider:string;key_hint?:string|null;base_url?:string|null;status:string};
type ModelRoute={id:string;provider_connection_id:string;provider_name:string;provider:string;task_key:string;model:string;priority:number;active:boolean;parameters?:Record<string,unknown>};
type CatalogModel={id:string;label:string};
type Plan={id:string;key:"free"|"pro";name:string;active:boolean;limits?:{dailyAiCredits?:number}|null};
type ModelDraft={providerConnectionId:string;taskKey:string;model:string;priority:number;parametersJson:string;active:boolean};
const tasks=["DEFAULT_CHAT","IMAGE_ANALYSIS","AUDIO_TRANSCRIPTION","PROMPT_SYNTHESIS","EMBEDDINGS","STRUCTURED_EXTRACTION","INTENT_CLASSIFICATION"] as const;
const presets=[500,1000,2000,5000,10000];
const inputStyle={padding:10,borderRadius:9,border:"1px solid #d1d5db",width:"100%",background:"white"} as const;
const primaryStyle={padding:"10px 14px",border:0,borderRadius:9,background:"#4f46e5",color:"white",fontWeight:750,cursor:"pointer"} as const;
const emptyDraft=(providerConnectionId=""):ModelDraft=>({providerConnectionId,taskKey:"DEFAULT_CHAT",model:"",priority:100,parametersJson:"{}",active:true});
type PlatformAiData={providers:Provider[];models:ModelRoute[];plans:Plan[];tokensPerCredit:number};
async function fetchPlatformAiData():Promise<PlatformAiData>{
  const[p,m,pl,settings]=await Promise.all([
    api<{providers?:Provider[]}>("/v1/admin/platform-ai/providers"),
    api<{models?:ModelRoute[]}>("/v1/admin/platform-ai/models"),
    api<{plans?:Plan[]}>("/v1/admin/plans"),
    api<{tokensPerCredit?:number}>("/v1/admin/platform-ai/settings"),
  ]);
  return {providers:p.providers??[],models:m.models??[],plans:pl.plans??[],tokensPerCredit:Number(settings.tokensPerCredit??1000)};
}

export default function PlatformAiPage(){
  const[providers,setProviders]=useState<Provider[]>([]);
  const[models,setModels]=useState<ModelRoute[]>([]);
  const[plans,setPlans]=useState<Plan[]>([]);
  const[catalogResult,setCatalogResult]=useState<{providerId:string;models:CatalogModel[]}>({providerId:"",models:[]});
  const[error,setError]=useState("");
  const[notice,setNotice]=useState("");
  const[busy,setBusy]=useState("");
  const[providerForm,setProviderForm]=useState({name:"",provider:"openai",apiKey:"",baseUrl:""});
  const[modelForm,setModelForm]=useState<ModelDraft>(emptyDraft());
  const[editing,setEditing]=useState<ModelRoute|null>(null);
  const[editDraft,setEditDraft]=useState<ModelDraft>(emptyDraft());
  const[planDrafts,setPlanDrafts]=useState<Record<string,number>>({});
  const[tokensPerCredit,setTokensPerCredit]=useState(1000);
  const[selectedPreset,setSelectedPreset]=useState("1000");

  const applyData=useCallback((data:PlatformAiData)=>{
    const providerRows=data.providers;
    setProviders(providerRows);
    setModels(data.models);
    setPlans(data.plans.filter(plan=>plan.key==="free"||plan.key==="pro"));
    setPlanDrafts(Object.fromEntries(data.plans.map(plan=>[plan.id,Number(plan.limits?.dailyAiCredits??0)])));
    setTokensPerCredit(data.tokensPerCredit);
    setSelectedPreset(presets.includes(data.tokensPerCredit)?String(data.tokensPerCredit):"custom");
    setModelForm(current=>({...current,providerConnectionId:current.providerConnectionId||providerRows[0]?.id||""}));
  },[]);
  const load=useCallback(async()=>{applyData(await fetchPlatformAiData());},[applyData]);
  useEffect(()=>{let active=true;void fetchPlatformAiData().then(data=>{if(active)applyData(data)}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Unable to load platform AI settings.")});return()=>{active=false};},[applyData]);

  const selectedProvider=useMemo(()=>providers.find(provider=>provider.id===modelForm.providerConnectionId),[providers,modelForm.providerConnectionId]);
  const catalog=catalogResult.providerId===modelForm.providerConnectionId?catalogResult.models:[];
  useEffect(()=>{
    if(!modelForm.providerConnectionId)return;
    let active=true;
    const providerId=modelForm.providerConnectionId;
    void api<{models?:CatalogModel[]}>(`/v1/admin/platform-ai/providers/${providerId}/catalog`).then(data=>{if(active)setCatalogResult({providerId,models:data.models??[]});}).catch(e=>{if(active){setCatalogResult({providerId,models:[]});setError(e instanceof Error?e.message:"Unable to load provider models.");}});
    return()=>{active=false;};
  },[modelForm.providerConnectionId]);

  async function addProvider(event:FormEvent){
    event.preventDefault();setError("");setNotice("");setBusy("provider");
    try{await api("/v1/admin/platform-ai/providers",{method:"POST",body:JSON.stringify({...providerForm,baseUrl:providerForm.baseUrl||undefined})});setProviderForm({name:"",provider:"openai",apiKey:"",baseUrl:""});setNotice("Platform AI provider saved.");await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to save provider.");}finally{setBusy("");}
  }
  async function addModel(event:FormEvent){
    event.preventDefault();setError("");setNotice("");setBusy("new-route");
    try{await api("/v1/admin/platform-ai/models",{method:"POST",body:JSON.stringify({...modelForm,parameters:JSON.parse(modelForm.parametersJson)})});setNotice(`${modelForm.taskKey} route saved.`);setModelForm(current=>({...current,model:""}));await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to save platform model route.");}finally{setBusy("");}
  }
  async function toggleModel(row:ModelRoute){
    setError("");setNotice("");setBusy(row.id);
    try{await api(`/v1/admin/platform-ai/models/${row.id}`,{method:"PATCH",body:JSON.stringify({active:!row.active})});setNotice(`Route ${row.active?"disabled":"enabled"}.`);await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to update route.");}finally{setBusy("");}
  }
  function startEdit(row:ModelRoute){setEditing(row);setEditDraft({providerConnectionId:row.provider_connection_id,taskKey:row.task_key,model:row.model,priority:Number(row.priority),parametersJson:JSON.stringify(row.parameters??{},null,2),active:row.active});setError("");}
  async function saveEdit(event:FormEvent){
    event.preventDefault();if(!editing)return;setError("");setNotice("");setBusy(editing.id);
    try{await api(`/v1/admin/platform-ai/models/${editing.id}`,{method:"PATCH",body:JSON.stringify({...editDraft,parameters:JSON.parse(editDraft.parametersJson)})});setEditing(null);setNotice("Platform route updated.");await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to update route.");}finally{setBusy("");}
  }
  async function deleteModel(row:ModelRoute){
    if(!confirm(`Delete the ${row.task_key} route for ${row.model}?`))return;
    setError("");setNotice("");setBusy(row.id);
    try{await api(`/v1/admin/platform-ai/models/${row.id}`,{method:"DELETE"});setNotice("Platform route deleted.");await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to delete route.");}finally{setBusy("");}
  }
  async function saveCreditRate(event:FormEvent){
    event.preventDefault();setError("");setNotice("");setBusy("credit-rate");
    try{await api("/v1/admin/platform-ai/settings",{method:"PATCH",body:JSON.stringify({tokensPerCredit})});setNotice(`Credit conversion saved: 1 credit = ${tokensPerCredit.toLocaleString()} tokens.`);await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to save the global credit conversion.");}finally{setBusy("");}
  }
  async function savePlan(plan:Plan){
    setError("");setNotice("");setBusy(plan.id);
    try{await api(`/v1/admin/plans/${plan.id}/ai-allowance`,{method:"PATCH",body:JSON.stringify({dailyAiCredits:planDrafts[plan.id]??0})});setNotice(`${plan.name} daily AI credits updated.`);await load();}
    catch(e){setError(e instanceof Error?e.message:"Unable to update daily credits.");}finally{setBusy("");}
  }

  return <AdminAccessGuard><main className="platform-ai-page">
    <header className="platform-ai-heading"><div><div className="platform-ai-eyebrow">Super Admin</div><h1>Platform AI</h1><p>Manage platform providers, task routes, one global credit conversion, and daily Free/Pro allowances.</p></div><Link className="platform-ai-back" href="/">← Admin dashboard</Link></header>
    {error&&<div role="alert" className="platform-ai-alert error">{error}</div>}{notice&&<div role="status" className="platform-ai-alert success">{notice}</div>}

    <div className="platform-ai-grid">
      <section className="platform-ai-card"><div className="platform-ai-card-head"><div><h2>Platform provider</h2><p>Credentials stay encrypted on the server.</p></div></div><form onSubmit={addProvider} className="platform-ai-form">
        <label>Name<input required style={inputStyle} value={providerForm.name} onChange={event=>setProviderForm({...providerForm,name:event.target.value})}/></label>
        <label>Provider<select style={inputStyle} value={providerForm.provider} onChange={event=>setProviderForm({...providerForm,provider:event.target.value})}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="openai_compatible">OpenAI-compatible</option></select></label>
        <label>API key<input required type="password" autoComplete="off" style={inputStyle} value={providerForm.apiKey} onChange={event=>setProviderForm({...providerForm,apiKey:event.target.value})}/></label>
        {providerForm.provider==="openai_compatible"&&<label>Base URL<input required style={inputStyle} value={providerForm.baseUrl} onChange={event=>setProviderForm({...providerForm,baseUrl:event.target.value})}/></label>}
        <button style={primaryStyle} disabled={busy==="provider"}>{busy==="provider"?"Saving…":"Save provider"}</button>
      </form><div className="platform-ai-provider-list">{providers.map(provider=><div className="platform-ai-provider" key={provider.id}><div><b>{provider.name}</b><small>{provider.provider} · {provider.key_hint||"key hidden"}</small></div><span className={`badge ${provider.status==="active"?"good":"warn"}`}>{provider.status}</span></div>)}{!providers.length&&<p className="muted">No providers configured.</p>}</div></section>

      <section className="platform-ai-card"><div className="platform-ai-card-head"><div><h2>Add task route</h2><p>Every route uses the global tokens-per-credit rate below.</p></div></div><form onSubmit={addModel} className="platform-ai-form">
        <label>Provider<select required style={inputStyle} value={modelForm.providerConnectionId} onChange={event=>setModelForm({...modelForm,providerConnectionId:event.target.value,model:""})}><option value="">Select provider</option>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name} · {provider.provider}</option>)}</select></label>
        <label>Task<select style={inputStyle} value={modelForm.taskKey} onChange={event=>setModelForm({...modelForm,taskKey:event.target.value})}>{tasks.map(task=><option key={task}>{task}</option>)}</select></label>
        <label>Model ID<input required list="platform-model-catalog" style={inputStyle} placeholder="Select or enter provider model" value={modelForm.model} onChange={event=>setModelForm({...modelForm,model:event.target.value})}/><datalist id="platform-model-catalog">{catalog.map(model=><option key={model.id} value={model.id}>{model.label}</option>)}</datalist><small>{selectedProvider?`${selectedProvider.provider} · ${catalog.length} models loaded`:"Choose a provider first"}</small></label>
        <div className="platform-ai-form-row"><label>Priority<input type="number" min="0" max="10000" style={inputStyle} value={modelForm.priority} onChange={event=>setModelForm({...modelForm,priority:Number(event.target.value)})}/></label><label>Parameters JSON<textarea rows={2} style={inputStyle} value={modelForm.parametersJson} onChange={event=>setModelForm({...modelForm,parametersJson:event.target.value})}/></label></div>
        <button style={primaryStyle} disabled={busy==="new-route"}>{busy==="new-route"?"Saving…":"Add route"}</button>
      </form></section>
    </div>

    <section className="platform-ai-card platform-ai-section"><div className="platform-ai-card-head"><div><h2>Global credit conversion</h2><p>One credit rate applies to every provider, model, and AI task.</p></div><span className="platform-ai-rate-chip">1 credit = {tokensPerCredit.toLocaleString()} tokens</span></div><form className="platform-ai-rate-form" onSubmit={saveCreditRate}><label>Tokens per credit<select style={inputStyle} value={selectedPreset} onChange={event=>{const value=event.target.value;setSelectedPreset(value);if(value!=="custom")setTokensPerCredit(Number(value));}}>{presets.map(rate=><option key={rate} value={rate}>{rate.toLocaleString()} tokens / credit</option>)}<option value="custom">Custom rate</option></select></label>{selectedPreset==="custom"&&<label>Custom tokens per credit<input type="number" min="0.000001" step="any" style={inputStyle} value={tokensPerCredit} onChange={event=>setTokensPerCredit(Number(event.target.value))}/></label>}<button style={primaryStyle} disabled={busy==="credit-rate"}>{busy==="credit-rate"?"Saving…":"Save conversion"}</button></form></section>

    <section className="platform-ai-card platform-ai-section"><div className="platform-ai-card-head"><div><h2>Platform routes</h2><p>Enable or disable traffic, edit route configuration, or remove a route.</p></div><span className="platform-ai-rate-chip">Global rate · {tokensPerCredit.toLocaleString()} tokens / credit</span></div><div className="platform-ai-table-wrap"><table className="platform-ai-table"><thead><tr><th>Task</th><th>Provider</th><th>Model</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead><tbody>{models.map(route=><tr key={route.id}><td><strong>{route.task_key}</strong></td><td>{route.provider_name}<small>{route.provider}</small></td><td><code>{route.model}</code></td><td>{route.priority}</td><td><span className={`badge ${route.active?"good":"neutral"}`}>{route.active?"Active":"Disabled"}</span></td><td><div className="platform-ai-actions"><button type="button" className="button ghost smallbtn" disabled={busy===route.id} onClick={()=>startEdit(route)}>Edit</button><button type="button" className="button" disabled={busy===route.id} onClick={()=>void toggleModel(route)}>{route.active?"Disable":"Enable"}</button><button type="button" className="button danger smallbtn" disabled={busy===route.id} onClick={()=>void deleteModel(route)}>{busy===route.id?"Working…":"Delete"}</button></div></td></tr>)}</tbody></table>{!models.length&&<p className="platform-ai-empty">No routes configured. Add a task route above.</p>}</div></section>

    <section className="platform-ai-card platform-ai-section"><div className="platform-ai-card-head"><div><h2>Daily package allowances</h2><p>Customers see credits only. Usage resets at 00:00 UTC every day.</p></div><span className="platform-ai-fixed-plans">Free · Pro</span></div><div className="platform-ai-plan-list">{plans.map(plan=><form className="platform-ai-plan-row" key={plan.id} onSubmit={event=>{event.preventDefault();void savePlan(plan);}}><div><b>{plan.name}</b><small>{plan.key} plan · {plan.active?"active":"inactive"}</small></div><label>Credits per day<input type="number" min="0" max="1000000" step="0.001" style={inputStyle} value={planDrafts[plan.id]??0} onChange={event=>setPlanDrafts({...planDrafts,[plan.id]:Number(event.target.value)})}/></label><button style={primaryStyle} disabled={busy===plan.id}>{busy===plan.id?"Saving…":"Save"}</button></form>)}</div></section>

    {editing&&<div className="platform-ai-modal-backdrop" onMouseDown={()=>setEditing(null)}><section className="platform-ai-modal" role="dialog" aria-modal="true" aria-labelledby="edit-route-title" onMouseDown={event=>event.stopPropagation()}><header><div><h2 id="edit-route-title">Edit platform route</h2><p>Changes apply to future AI calls for this route.</p></div><button type="button" className="button ghost" onClick={()=>setEditing(null)} aria-label="Close">×</button></header><form onSubmit={saveEdit} className="platform-ai-form">
      <label>Provider<select required style={inputStyle} value={editDraft.providerConnectionId} onChange={event=>setEditDraft({...editDraft,providerConnectionId:event.target.value})}>{providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name} · {provider.provider}</option>)}</select></label>
      <label>Task<select style={inputStyle} value={editDraft.taskKey} onChange={event=>setEditDraft({...editDraft,taskKey:event.target.value})}>{tasks.map(task=><option key={task}>{task}</option>)}</select></label>
      <label>Model ID<input required style={inputStyle} value={editDraft.model} onChange={event=>setEditDraft({...editDraft,model:event.target.value})}/></label>
      <div className="platform-ai-form-row"><label>Priority<input type="number" min="0" max="10000" style={inputStyle} value={editDraft.priority} onChange={event=>setEditDraft({...editDraft,priority:Number(event.target.value)})}/></label><label>Parameters JSON<textarea rows={4} style={inputStyle} value={editDraft.parametersJson} onChange={event=>setEditDraft({...editDraft,parametersJson:event.target.value})}/></label></div>
      <label className="platform-ai-toggle"><input type="checkbox" checked={editDraft.active} onChange={event=>setEditDraft({...editDraft,active:event.target.checked})}/> Route enabled</label>
      {error&&<div role="alert" className="platform-ai-alert error">{error}</div>}
      <div className="platform-ai-modal-actions"><button type="button" className="button" onClick={()=>setEditing(null)}>Cancel</button><button style={primaryStyle} disabled={busy===editing.id}>{busy===editing.id?"Saving…":"Save route"}</button></div>
    </form></section></div>}
  </main></AdminAccessGuard>;
}
