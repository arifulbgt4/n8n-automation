"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { api } from "../../lib/api";
import AdminAccessGuard from "../../components/AdminAccessGuard";

type Plan={id:string;key:string;name:string;active:boolean;limits:Record<string,any>};
type Draft={maxImageMegapixels:number;maxImageAssets:number;maxImageBytesMb:number;mediaStorageMb:number};

const card={background:"#fff",border:"1px solid #e5e7eb",borderRadius:14,padding:18} as const;
const ctl={width:"100%",border:"1px solid #d1d5db",borderRadius:8,padding:"9px 10px",font:"inherit"} as const;

function draft(plan:Plan):Draft{return{
  maxImageMegapixels:Number(plan.limits?.maxImageMegapixels??10),
  maxImageAssets:Number(plan.limits?.maxImageAssets??100),
  maxImageBytesMb:Math.round(Number(plan.limits?.maxImageBytes??10485760)/1024/1024),
  mediaStorageMb:Math.round(Number(plan.limits?.mediaStorageBytes??536870912)/1024/1024),
}}

export default function MediaPlansPage(){
 const[plans,setPlans]=useState<Plan[]>([]);const[drafts,setDrafts]=useState<Record<string,Draft>>({});const[error,setError]=useState("");const[notice,setNotice]=useState("");const[busy,setBusy]=useState("");
 async function load(){try{const r=await api<any>("/v1/admin/plans");const rows=(r.plans??[]).filter((p:Plan)=>p.key!=="starter");setPlans(rows);setDrafts(Object.fromEntries(rows.map((p:Plan)=>[p.id,draft(p)])))}catch(e){setError(e instanceof Error?e.message:"Unable to load plans.")}}
 useEffect(()=>{void load()},[]);
 function change(id:string,key:keyof Draft,value:string){setDrafts(d=>({...d,[id]:{...d[id],[key]:Number(value)}}))}
 async function save(e:FormEvent,plan:Plan){e.preventDefault();const d=drafts[plan.id];if(!d)return;setBusy(plan.id);setError("");setNotice("");try{await api(`/v1/admin/plans/${plan.id}/media-allowance`,{method:"PATCH",body:JSON.stringify({maxImageMegapixels:d.maxImageMegapixels,maxImageAssets:d.maxImageAssets,maxImageBytes:Math.round(d.maxImageBytesMb*1024*1024),mediaStorageBytes:Math.round(d.mediaStorageMb*1024*1024)})});setNotice(`${plan.name} media limits saved.`);await load()}catch(err){setError(err instanceof Error?err.message:"Unable to save media limits.")}finally{setBusy("")}}
 return <AdminAccessGuard><main style={{minHeight:"100vh",background:"#f6f8fc",fontFamily:"Inter,system-ui,sans-serif",padding:"32px 24px"}}><div style={{maxWidth:1100,margin:"0 auto"}}>
  <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"flex-start",marginBottom:22}}><div><div style={{fontSize:12,textTransform:"uppercase",letterSpacing:".12em",color:"#6b7280",fontWeight:800}}>Super Admin</div><h1 style={{margin:"5px 0 6px"}}>Media package limits</h1><p style={{margin:0,color:"#667085",maxWidth:760}}>Protect VPS storage with package-aware image count, megapixel, encoded-size and total storage limits. Limits are enforced server-side before files are written to Media Storage.</p></div><div style={{display:"flex",gap:12}}><Link href="/platform-ai" style={{color:"#4f46e5",fontWeight:700}}>Platform AI</Link><Link href="/" style={{color:"#4f46e5",fontWeight:700}}>Dashboard</Link></div></div>
  {error&&<div style={{...card,borderColor:"#fecaca",background:"#fff7f6",color:"#b42318",marginBottom:14}}>{error}</div>}{notice&&<div style={{...card,borderColor:"#a7f3d0",background:"#ecfdf5",color:"#047857",marginBottom:14}}>{notice}</div>}
  <div style={{display:"grid",gap:14}}>{plans.map(plan=>{const d=drafts[plan.id]??draft(plan);return <form key={plan.id} onSubmit={e=>void save(e,plan)} style={card}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}><div><h2 style={{margin:0}}>{plan.name}</h2><div style={{fontSize:13,color:"#667085",marginTop:4}}>{plan.key} · {plan.active?"active":"inactive"}</div></div><button disabled={busy===plan.id} style={{border:0,borderRadius:8,padding:"10px 15px",background:"#4f46e5",color:"#fff",fontWeight:750,cursor:"pointer"}}>{busy===plan.id?"Saving…":"Save limits"}</button></div><div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12}}>
   <label style={{display:"grid",gap:6,fontSize:13,color:"#475467"}}>Max megapixels / image<input style={ctl} type="number" step="0.1" min="1" max="100" value={d.maxImageMegapixels} onChange={e=>change(plan.id,"maxImageMegapixels",e.target.value)}/></label>
   <label style={{display:"grid",gap:6,fontSize:13,color:"#475467"}}>Max stored images<input style={ctl} type="number" min="0" value={d.maxImageAssets} onChange={e=>change(plan.id,"maxImageAssets",e.target.value)}/></label>
   <label style={{display:"grid",gap:6,fontSize:13,color:"#475467"}}>Max encoded image size (MB)<input style={ctl} type="number" min="1" value={d.maxImageBytesMb} onChange={e=>change(plan.id,"maxImageBytesMb",e.target.value)}/></label>
   <label style={{display:"grid",gap:6,fontSize:13,color:"#475467"}}>Total media storage (MB)<input style={ctl} type="number" min="0" value={d.mediaStorageMb} onChange={e=>change(plan.id,"mediaStorageMb",e.target.value)}/></label>
  </div></form>})}</div>
  {!plans.length&&!error&&<div style={card}>Loading plans…</div>}
 </div></main></AdminAccessGuard>
}
