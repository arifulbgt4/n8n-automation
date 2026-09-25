"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

type Membership={tenant_id:string;tenant_name:string;role:string};
type Allowance={
  plan:{id:string|null;key:string|null;name:string|null};
  periodStart:string;
  tokenLimit:number|null;
  creditLimit:number|null;
  tokensUsed:number;
  creditsUsed:number;
  tokensRemaining:number|null;
  creditsRemaining:number|null;
};

function pct(used:number,limit:number|null){return limit&&limit>0?Math.min(100,(used/limit)*100):0;}
function num(value:number|null,digits=0){if(value===null)return "Unlimited";return new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(value);}

export default function UsagePage(){
  const[memberships,setMemberships]=useState<Membership[]>([]);
  const[tenantId,setTenantId]=useState("");
  const[data,setData]=useState<Allowance|null>(null);
  const[error,setError]=useState("");
  useEffect(()=>{api<any>("/v1/auth/me").then(result=>{const rows=result?.memberships??[];setMemberships(rows);setTenantId(rows[0]?.tenant_id??"");}).catch(e=>setError(e instanceof Error?e.message:"Unable to load account."));},[]);
  useEffect(()=>{if(!tenantId)return;setError("");api<Allowance>(`/v1/tenants/${tenantId}/ai/allowance`).then(setData).catch(e=>setError(e instanceof Error?e.message:"Unable to load AI allowance."));},[tenantId]);
  const tokenPct=useMemo(()=>data?pct(data.tokensUsed,data.tokenLimit):0,[data]);
  const creditPct=useMemo(()=>data?pct(data.creditsUsed,data.creditLimit):0,[data]);
  return <main style={{maxWidth:980,margin:"0 auto",padding:"36px 24px",fontFamily:"Inter,system-ui,sans-serif"}}>
    <div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",marginBottom:24}}>
      <div><div style={{color:"#6b7280",fontSize:13,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>Customer Panel</div><h1 style={{margin:"6px 0"}}>Monthly AI usage</h1><p style={{color:"#6b7280",margin:0}}>Chat, training, embeddings, image analysis and audio processing all consume the same monthly package allowance.</p></div>
      <div style={{display:"flex",gap:14}}><Link href="/channel-ai" style={{color:"#4f46e5",fontWeight:700,textDecoration:"none"}}>Channel AI setup</Link><Link href="/" style={{color:"#4f46e5",fontWeight:700,textDecoration:"none"}}>← Dashboard</Link></div>
    </div>
    <label style={{display:"grid",gap:6,maxWidth:460,marginBottom:20}}><span style={{fontSize:13,color:"#6b7280"}}>Workspace</span><select value={tenantId} onChange={e=>setTenantId(e.target.value)} style={{padding:10,borderRadius:8,border:"1px solid #d1d5db"}}>{memberships.map(m=><option key={m.tenant_id} value={m.tenant_id}>{m.tenant_name} · {m.role}</option>)}</select></label>
    {error&&<div style={{padding:12,marginBottom:16,borderRadius:8,background:"#fef2f2",color:"#991b1b"}}>{error}</div>}
    {data&&<>
      <section style={{border:"1px solid #e5e7eb",borderRadius:14,padding:20,background:"white",marginBottom:18}}><div style={{fontSize:13,color:"#6b7280",textTransform:"uppercase",fontWeight:700}}>Current package</div><div style={{fontSize:28,fontWeight:800,marginTop:5}}>{data.plan.name||data.plan.key||"Unassigned"}</div><div style={{color:"#6b7280",marginTop:4}}>Monthly cycle starting {new Date(data.periodStart).toLocaleDateString()} · payment checkout is not enabled.</div></section>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>
        <section style={{border:"1px solid #e5e7eb",borderRadius:14,padding:20,background:"white"}}><div style={{display:"flex",justifyContent:"space-between",gap:12}}><div><div style={{color:"#6b7280",fontSize:13}}>AI tokens</div><strong style={{fontSize:28}}>{num(data.tokensUsed)}</strong></div><div style={{textAlign:"right",color:"#6b7280"}}>of {num(data.tokenLimit)}<br/><b>{num(data.tokensRemaining)} remaining</b></div></div><div style={{height:10,background:"#eef2ff",borderRadius:999,overflow:"hidden",marginTop:18}}><div style={{height:"100%",width:`${tokenPct}%`,background:"#4f46e5"}}/></div></section>
        <section style={{border:"1px solid #e5e7eb",borderRadius:14,padding:20,background:"white"}}><div style={{display:"flex",justifyContent:"space-between",gap:12}}><div><div style={{color:"#6b7280",fontSize:13}}>AI credits</div><strong style={{fontSize:28}}>{num(data.creditsUsed,3)}</strong></div><div style={{textAlign:"right",color:"#6b7280"}}>of {num(data.creditLimit,3)}<br/><b>{num(data.creditsRemaining,3)} remaining</b></div></div><div style={{height:10,background:"#eef2ff",borderRadius:999,overflow:"hidden",marginTop:18}}><div style={{height:"100%",width:`${creditPct}%`,background:"#4f46e5"}}/></div></section>
      </div>
      <p style={{color:"#6b7280",fontSize:13,marginTop:18}}>Tokens measure actual model input/output usage. Credits are weighted by the platform model route, so higher-cost models can consume more credits per token. Allowances reset by calendar month.</p>
    </>}
  </main>;
}
