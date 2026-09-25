"use client";

import Link from "next/link";

export default function AiModelsPage(){
  return <main style={{maxWidth:820,margin:"0 auto",padding:"48px 24px",fontFamily:"Inter,system-ui,sans-serif"}}>
    <div style={{color:"#6b7280",fontSize:13,fontWeight:700,textTransform:"uppercase",letterSpacing:".08em"}}>Customer Panel</div>
    <h1 style={{margin:"8px 0 12px"}}>AI models are managed by the platform</h1>
    <p style={{color:"#6b7280",fontSize:17,lineHeight:1.65}}>Customers no longer add provider API keys or select provider model IDs. The platform administrator configures the approved AI providers and task models. Your workspace automatically uses those models within its monthly token and credit allowance.</p>
    <section style={{marginTop:24,border:"1px solid #e5e7eb",borderRadius:14,padding:20,background:"white"}}>
      <h2 style={{marginTop:0}}>What you still control</h2>
      <ul style={{lineHeight:1.9,color:"#374151"}}><li>Create and train business AI agents.</li><li>Choose which agent is assigned to each connected channel.</li><li>Manage business data, knowledge and training examples.</li><li>Monitor monthly token and credit usage.</li></ul>
    </section>
    <div style={{display:"flex",gap:12,marginTop:24,flexWrap:"wrap"}}><Link href="/usage" style={{padding:"11px 16px",borderRadius:8,background:"#4f46e5",color:"white",fontWeight:700,textDecoration:"none"}}>View monthly usage</Link><Link href="/channel-ai" style={{padding:"11px 16px",borderRadius:8,border:"1px solid #d1d5db",color:"#111827",fontWeight:700,textDecoration:"none"}}>Channel AI setup</Link><Link href="/" style={{padding:"11px 16px",color:"#4f46e5",fontWeight:700,textDecoration:"none"}}>← Dashboard</Link></div>
  </main>;
}
