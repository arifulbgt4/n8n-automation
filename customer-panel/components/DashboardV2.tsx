"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api, qs } from "../lib/api";

type Allowance={
  plan:{id:string|null;key:string|null;name:string|null};
  periodStart:string;
  resetAt:string;
  creditLimit:number|null;
  creditsUsed:number;
  creditsRemaining:number|null;
};

type DashboardData={overview:any;channels:any[];agents:any[];allowance:Allowance|null};

const cardStyle={background:"#fff",border:"1px solid #dfe5ef",borderRadius:14,padding:"18px 20px",minHeight:112,boxShadow:"0 1px 2px rgba(15,23,42,.025)"} as const;
const panelStyle={background:"#fff",border:"1px solid #dfe5ef",borderRadius:14,padding:20} as const;

function number(value:unknown,maximumFractionDigits=0){
  const n=Number(value??0);
  return new Intl.NumberFormat(undefined,{maximumFractionDigits}).format(Number.isFinite(n)?n:0);
}
function percent(used:number,limit:number|null){
  if(limit===null||limit<=0)return 0;
  return Math.min(100,Math.max(0,(used/limit)*100));
}
function Metric({label,value,note}:{label:string;value:string;note:string}){
  return <div style={cardStyle}><div style={{fontSize:14,color:"#667085",marginBottom:12}}>{label}</div><div style={{fontSize:29,lineHeight:1,fontWeight:750,color:"#182033",letterSpacing:"-.02em"}}>{value}</div><div style={{fontSize:12,color:"#8490a3",marginTop:12}}>{note}</div></div>;
}
function UsageBar({label,used,limit,remaining,unit}:{label:string;used:number;limit:number|null;remaining:number|null;unit:string}){
  const pct=percent(used,limit);
  return <div style={{display:"grid",gap:8}}><div style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:13}}><b style={{color:"#253046"}}>{label}</b><span style={{color:"#667085"}}>{limit===null?`${number(used,2)} used`:`${number(remaining,2)} ${unit} remaining`}</span></div><div style={{height:9,borderRadius:99,background:"#eef1f6",overflow:"hidden"}}><div style={{height:"100%",width:`${limit===null?0:pct}%`,borderRadius:99,background:"linear-gradient(90deg,#6d5dfc,#4f46e5)"}}/></div><div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#8490a3"}}><span>{number(used,2)} used</span><span>{limit===null?"No daily ceiling":`${number(limit,2)} limit · ${pct.toFixed(1)}%`}</span></div></div>;
}

export default function DashboardV2(){
  const[host,setHost]=useState<HTMLElement|null>(null);
  const[active,setActive]=useState(false);
  const[tenantId,setTenantId]=useState("");
  const[businessId,setBusinessId]=useState("");
  const[businessName,setBusinessName]=useState("All businesses");
  const[data,setData]=useState<DashboardData|null>(null);
  const[loading,setLoading]=useState(false);
  const[error,setError]=useState("");

  useEffect(()=>{
    const styleId="customer-dashboard-v2-style";
    if(!document.getElementById(styleId)){
      const style=document.createElement("style");
      style.id=styleId;
      style.textContent=`.content.dashboard-v2-active > :not(.dashboard-v2-host){display:none!important}.dashboard-v2-host{display:block!important}`;
      document.head.appendChild(style);
    }

    const sync=()=>{
      const heading=document.querySelector<HTMLElement>(".main .topbar h1");
      const content=document.querySelector<HTMLElement>(".main .content");
      const selectors=document.querySelectorAll<HTMLSelectElement>(".main .topbar .selectors select");
      const isDashboard=(heading?.textContent||"").trim()==="Dashboard";
      setActive(isDashboard);
      if(content){
        let nextHost=content.querySelector<HTMLElement>(":scope > .dashboard-v2-host");
        if(!nextHost){
          nextHost=document.createElement("div");
          nextHost.className="dashboard-v2-host";
          content.appendChild(nextHost);
        }
        content.classList.toggle("dashboard-v2-active",isDashboard);
        setHost(nextHost);
      }
      const tenant=selectors[0]?.value||"";
      const business=selectors[1]?.value||"";
      const businessText=selectors[1]?.selectedOptions?.[0]?.textContent?.trim()||"All businesses";
      setTenantId(tenant);
      setBusinessId(business);
      setBusinessName(businessText);
    };

    sync();
    const observer=new MutationObserver(sync);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
    const onChange=(event:Event)=>{if((event.target as HTMLElement)?.matches?.(".main .topbar .selectors select"))setTimeout(sync,0)};
    document.addEventListener("change",onChange);
    return()=>{observer.disconnect();document.removeEventListener("change",onChange);document.querySelector<HTMLElement>(".main .content")?.classList.remove("dashboard-v2-active");};
  },[]);

  const load=useCallback(async()=>{
    if(!active||!tenantId)return;
    setLoading(true);setError("");
    try{
      const[overview,channels,agents,allowance]=await Promise.all([
        api<any>(`/v1/tenants/${tenantId}/analytics/overview${qs({businessId})}`),
        api<any>(`/v1/tenants/${tenantId}/channels${qs({businessId})}`),
        api<any>(`/v1/tenants/${tenantId}/agents${qs({businessId})}`),
        api<Allowance>(`/v1/tenants/${tenantId}/ai/allowance`),
      ]);
      setData({overview,channels:channels.channels??[],agents:agents.agents??[],allowance});
    }catch(e){setError(e instanceof Error?e.message:"Unable to load dashboard.");}
    finally{setLoading(false);}
  },[active,tenantId,businessId]);
  useEffect(()=>{void load();},[load]);

  const agentMap=useMemo(()=>new Map((data?.agents??[]).map(a=>[a.id,a])),[data?.agents]);
  if(!host||!active)return null;

  const allowance=data?.allowance;
  const metrics=data?.overview?.metrics??{};
  const conversations=data?.overview?.conversations??{};
  const outcomes=data?.overview?.outcomes??{};
  const channels=data?.channels??[];
  const readyChannels=channels.filter(c=>c.active!==false&&c.connection_status==="connected"&&c.default_agent_profile_id).length;
  const planName=allowance?.plan?.name||allowance?.plan?.key||"No plan";

  return createPortal(<div style={{display:"grid",gap:24}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:20,flexWrap:"wrap"}}><div><h2 style={{margin:"0 0 6px",fontSize:25,fontWeight:650,color:"#172033"}}>Business overview</h2><p style={{margin:0,color:"#737f92"}}>Messages, automation readiness and daily AI credits for <b style={{color:"#475467"}}>{businessName}</b>.</p></div><div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{padding:"7px 11px",borderRadius:99,background:"#ede9fe",color:"#5b46dc",fontSize:12,fontWeight:750}}>{planName} plan</span><span style={{padding:"7px 11px",borderRadius:99,background:readyChannels===channels.length&&channels.length?"#e8f8f1":"#fff5e8",color:readyChannels===channels.length&&channels.length?"#16775a":"#9a5b13",fontSize:12,fontWeight:750}}>{channels.length?`${readyChannels}/${channels.length} channels AI-ready`:"No channels"}</span></div></div>

    {error&&<div style={{padding:13,borderRadius:10,background:"#fef2f2",color:"#991b1b"}}>{error}</div>}
    {loading&&!data?<div style={{padding:30,textAlign:"center",color:"#737f92"}}>Loading dashboard…</div>:<>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:14}}>
        <Metric label="AI credits remaining today" value={allowance?.creditsRemaining===null?"Unlimited":number(allowance?.creditsRemaining,2)} note={allowance?.creditLimit===null?`${number(allowance?.creditsUsed,2)} used today`:`${number(allowance?.creditsUsed,2)} / ${number(allowance?.creditLimit,2)} used today`}/>
        <Metric label="AI calls" value={number(metrics.ai_call?.quantity)} note="Platform-managed AI operations"/>
        <Metric label="Open conversations" value={number(conversations.open)} note={`${number(conversations.ai)} AI · ${number(conversations.human)} human mode`}/>
        <Metric label="Messages" value={`${number(metrics.inbound_message?.quantity)} / ${number(metrics.outbound_message?.quantity)}`} note="Inbound / outbound"/>
        <Metric label="Business outcomes" value={number((Number(outcomes.orders)||0)+(Number(outcomes.bookings)||0)+(Number(outcomes.leads)||0))} note={`${number(outcomes.orders)} orders · ${number(outcomes.bookings)} bookings · ${number(outcomes.leads)} leads`}/>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"minmax(0,1.15fr) minmax(0,.85fr)",gap:18}}>
        <section style={panelStyle}><div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",marginBottom:20}}><div><h3 style={{margin:"0 0 5px",fontSize:18,color:"#1f2937"}}>Daily AI credits</h3><p style={{margin:0,fontSize:13,color:"#7b8798"}}>All chat, training, embeddings, image and audio AI usage shares this allowance.</p></div><div style={{fontSize:12,color:"#7b8798"}}>Resets {allowance?new Date(allowance.resetAt).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit",timeZone:"UTC"})+" UTC":"at 00:00 UTC"}</div></div><UsageBar label="Credits" used={allowance?.creditsUsed??0} limit={allowance?.creditLimit??null} remaining={allowance?.creditsRemaining??null} unit="credits"/></section>

        <section style={panelStyle}><h3 style={{margin:"0 0 5px",fontSize:18,color:"#1f2937"}}>Automation readiness</h3><p style={{margin:"0 0 16px",fontSize:13,color:"#7b8798"}}>A connected channel needs an active agent. Assign it in AI Agents.</p><div style={{display:"grid",gap:10}}>{channels.slice(0,6).map(c=>{const agent=agentMap.get(c.default_agent_profile_id);const connected=c.active!==false&&c.connection_status==="connected";const ready=connected&&Boolean(agent);return <div key={c.id} style={{display:"flex",justifyContent:"space-between",gap:14,alignItems:"center",padding:"10px 0",borderTop:"1px solid #eef1f5"}}><div><b style={{display:"block",fontSize:14,color:"#253046"}}>{c.name}</b><span style={{fontSize:12,color:"#8490a3",textTransform:"capitalize"}}>{c.platform} · {agent?`agent: ${agent.name}`:"no default agent"}</span></div>{ready?<span style={{padding:"5px 9px",borderRadius:99,fontSize:11,fontWeight:750,background:"#e8f8f1",color:"#16775a"}}>AI ready</span>:connected?<button type="button" onClick={()=>window.location.assign("/?view=agents")} style={{padding:"7px 10px",borderRadius:9,border:"1px solid #d8d4fa",background:"#f2f0ff",color:"#5142c9",fontSize:11,fontWeight:750}}>Set agent</button>:<span style={{padding:"5px 9px",borderRadius:99,fontSize:11,fontWeight:750,background:"#f3f4f6",color:"#667085"}}>{c.connection_status||"offline"}</span>}</div>})}{!channels.length&&<div style={{padding:"22px 0",color:"#8490a3",fontSize:13}}>Connect Facebook, Instagram or WhatsApp to begin.</div>}</div></section>
      </div>

      <section style={panelStyle}><div style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"center",marginBottom:14}}><div><h3 style={{margin:"0 0 5px",fontSize:18,color:"#1f2937"}}>Current operating picture</h3><p style={{margin:0,fontSize:13,color:"#7b8798"}}>A concise view of message flow and outcomes in the selected scope.</p></div><span style={{fontSize:12,color:"#8490a3"}}>AI provider/model selection is managed centrally by the platform.</span></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10}}>{[["Inbound",metrics.inbound_message?.quantity],["Outbound",metrics.outbound_message?.quantity],["AI conversations",conversations.ai],["Human conversations",conversations.human],["Orders",outcomes.orders],["Bookings",outcomes.bookings],["Leads",outcomes.leads]].map(([label,value])=><div key={String(label)} style={{padding:14,borderRadius:10,background:"#f7f9fc"}}><div style={{fontSize:12,color:"#7b8798"}}>{label}</div><div style={{fontSize:22,fontWeight:750,color:"#253046",marginTop:5}}>{number(value)}</div></div>)}</div></section>
    </>}
  </div>,host);
}
