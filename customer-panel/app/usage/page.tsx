"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

type Membership={tenant_id:string;tenant_name:string;role:string};
type Allowance={
  plan:{id:string|null;key:string|null;name:string|null};
  periodStart:string;
  resetAt:string;
  creditLimit:number|null;
  creditsUsed:number;
  creditsRemaining:number|null;
};

function pct(used:number,limit:number|null){return limit&&limit>0?Math.min(100,(used/limit)*100):0;}
function num(value:number|null,digits=0){if(value===null)return "Unlimited";return new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(value);}

export default function UsagePage({embedded=false,workspaceId}:{embedded?:boolean;workspaceId?:string}={}){
  const[memberships,setMemberships]=useState<Membership[]>([]);
  const[selectedTenantId,setSelectedTenantId]=useState("");
  const tenantId=workspaceId??selectedTenantId;
  const[loaded,setLoaded]=useState<{tenantId:string;data:Allowance}|null>(null);
  const data=loaded?.tenantId===tenantId?loaded.data:null;
  const[error,setError]=useState("");
  useEffect(()=>{if(workspaceId!==undefined)return;api<{memberships?:Membership[]}>("/v1/auth/me").then(result=>{const rows=result.memberships??[];setMemberships(rows);setSelectedTenantId(rows[0]?.tenant_id??"");}).catch(e=>setError(e instanceof Error?e.message:"Unable to load account."));},[workspaceId]);
  useEffect(()=>{if(!tenantId)return;api<Allowance>(`/v1/tenants/${tenantId}/ai/allowance`).then(result=>{setLoaded({tenantId,data:result});setError("");}).catch(e=>setError(e instanceof Error?e.message:"Unable to load AI allowance."));},[tenantId]);
  const progress=useMemo(()=>data?pct(data.creditsUsed,data.creditLimit):0,[data]);

  return <main style={{maxWidth:980,margin:"0 auto",padding:embedded?"0":"36px 24px",fontFamily:"Inter,system-ui,sans-serif"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",marginBottom:24}}>
      <div>{!embedded&&<div style={{color:"#6b7280",fontSize:13,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>Customer Panel</div>}<h1 style={{margin:"6px 0"}}>Daily AI credits</h1><p style={{color:"#6b7280",margin:0}}>Chat, training, embeddings, image analysis and audio processing share one daily credit allowance.</p></div>
      {!embedded&&<Link href="/" style={{color:"#4f46e5",fontWeight:700,textDecoration:"none"}}>← Dashboard</Link>}
    </div>
    {!embedded&&<label style={{display:"grid",gap:6,maxWidth:460,marginBottom:20}}><span style={{fontSize:13,color:"#6b7280"}}>Workspace</span><select value={tenantId} onChange={e=>setSelectedTenantId(e.target.value)} style={{padding:10,borderRadius:8,border:"1px solid #d1d5db"}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenant_name} · {m.role}</option>)}</select></label>}
    {error&&<div role="alert" style={{padding:12,marginBottom:16,borderRadius:8,background:"#fef2f2",color:"#991b1b"}}>{error}</div>}
    {data&&<section style={{border:"1px solid #e5e7eb",borderRadius:14,padding:22,background:"white",marginBottom:18}}>
      <div style={{fontSize:13,color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Current package</div>
      <div style={{fontSize:28,fontWeight:800,marginTop:5}}>{data.plan.name||data.plan.key||"Unassigned"}</div>
      <div style={{color:"#6b7280",marginTop:4}}>Daily allowance · resets {new Date(data.resetAt).toLocaleString(undefined,{timeZone:"UTC",dateStyle:"medium",timeStyle:"short"})} UTC.</div>
      <div style={{display:"flex",justifyContent:"space-between",gap:12,marginTop:22}}><div><div style={{color:"#6b7280",fontSize:13}}>AI credits used today</div><strong style={{fontSize:32}}>{num(data.creditsUsed,3)}</strong></div><div style={{textAlign:"right",color:"#6b7280"}}>of {num(data.creditLimit,3)}<br/><b>{num(data.creditsRemaining,3)} remaining</b></div></div>
      <div style={{height:10,background:"#eef2ff",borderRadius:999,overflow:"hidden",marginTop:18}}><div style={{height:"100%",width:`${progress}%`,background:"#4f46e5"}}/></div>
      <p style={{color:"#6b7280",fontSize:13,margin:"12px 0 0"}}>Credit usage follows one platform-wide rate across channels and AI tasks.</p>
    </section>}
  </main>;
}
