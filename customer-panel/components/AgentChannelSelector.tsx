"use client";

export type AgentChannel = {
  id: string;
  business_id?: string;
  name: string;
  platform: string;
  connection_status: string;
  active: boolean;
};

export default function AgentChannelSelector({channels,selectedIds,onChange,loading,error,onRetry}:{
  channels:AgentChannel[];
  selectedIds:string[];
  onChange:(ids:string[])=>void;
  loading:boolean;
  error:string;
  onRetry:()=>void;
}) {
  const unavailableIds=selectedIds.filter(id=>!channels.some(channel=>channel.id===id));
  const toggle=(id:string)=>onChange(selectedIds.includes(id)?selectedIds.filter(value=>value!==id):[...selectedIds,id]);
  return <fieldset className="agent-channel-selector">
    <legend>Channels · {selectedIds.length} selected</legend>
    <p>Choose where this agent should reply. Saving makes it the default agent for each selected channel.</p>
    {loading?<p role="status" className="muted small">Loading channels…</p>:error?<div role="alert" className="stack"><span className="alert error">{error}</span><button type="button" className="button ghost smallbtn" onClick={onRetry}>Retry loading channels</button></div>:channels.length?<div className="agent-channel-options">
      {channels.map(channel=><label className="agent-channel-option" key={channel.id}>
        <input type="checkbox" checked={selectedIds.includes(channel.id)} onChange={()=>toggle(channel.id)}/>
        <span className="grow"><strong>{channel.name}</strong><small>{channel.platform} · {channel.active?channel.connection_status:"paused"}</small></span>
        <span className={`badge ${channel.active&&channel.connection_status==="connected"?"good":"warn"}`}>{channel.active&&channel.connection_status==="connected"?"Ready":channel.active?channel.connection_status:"paused"}</span>
      </label>)}
    </div>:<p className="muted small">No channels are connected to this business yet. Connect one in Businesses &amp; Channels first.</p>}
    {!loading&&!error&&unavailableIds.length>0&&<div role="alert" className="alert warn">Some currently assigned channels are no longer available. Reload the page before saving.</div>}
  </fieldset>;
}
