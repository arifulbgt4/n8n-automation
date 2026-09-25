import { readFile } from "node:fs/promises";
import path from "node:path";

const args=new Set(process.argv.slice(2));
const apply=args.has("--apply");
const activate=args.has("--activate");
const deactivateConflicts=args.has("--deactivate-conflicts");
const environment=(process.argv.find((v)=>v.startsWith("--environment="))?.split("=")[1] || process.env.N8N_DEPLOY_ENV || "development").trim();
const apiUrl=(process.env.N8N_API_URL || "").replace(/\/$/,"");
const apiKey=process.env.N8N_API_KEY || "";
const root=path.resolve("automation/n8n");
const manifest=JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8"));

function workflowPayload(source){
  // n8n owns workflow staticData at runtime and can mutate it when a workflow is
  // activated or executed. It is deliberately excluded from source-controlled
  // deployment drift checks so an already-active canonical workflow remains
  // idempotent across repeated deploys.
  return {
    name:source.name,
    nodes:source.nodes,
    connections:source.connections ?? {},
    settings:source.settings ?? {},
  };
}
function stable(value){
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value==="object"){
    return Object.fromEntries(Object.keys(value).sort().filter((k)=>value[k]!==undefined).map((k)=>[k,stable(value[k])]));
  }
  return value;
}
function equal(a,b){return JSON.stringify(stable(a))===JSON.stringify(stable(b));}
function webhookSignatures(workflow){
  return (workflow.nodes??[])
    .filter((node)=>String(node.type||"").toLowerCase().endsWith(".webhook"))
    .map((node)=>{
      const method=String(node.parameters?.httpMethod||"GET").toUpperCase();
      const route=String(node.parameters?.path||"").replace(/^\/+|\/+$/g,"");
      return route ? `webhook:${method}:${route}` : null;
    })
    .filter(Boolean);
}

async function n8n(pathname,init={}){
  if(!apiUrl || !apiKey) throw new Error("N8N_API_URL and N8N_API_KEY are required for --apply.");
  const base=apiUrl.endsWith("/api/v1")?apiUrl:`${apiUrl}/api/v1`;
  const headers=new Headers(init.headers);
  headers.set("X-N8N-API-KEY",apiKey);
  if(init.body&&!headers.has("content-type")) headers.set("content-type","application/json");
  const response=await fetch(`${base}${pathname}`,{...init,headers});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error((body?.message||body?.error||`n8n API ${response.status}`) + ` [${pathname}]`);
  return body;
}

async function listWorkflows(){
  const all=[]; let cursor="";
  do{
    const qs=new URLSearchParams({limit:"250"});
    if(cursor)qs.set("cursor",cursor);
    const body=await n8n(`/workflows?${qs}`);
    all.push(...(Array.isArray(body)?body:(body.data??[])));
    cursor=body.nextCursor || body.next_cursor || "";
  }while(cursor);
  return all;
}
async function getWorkflow(id){return n8n(`/workflows/${encodeURIComponent(id)}`);}

async function recordDeployment(record){
  const saas=(process.env.SAAS_API_INTERNAL_URL||"").replace(/\/$/,"");
  const secret=process.env.INTERNAL_SERVICE_AUTH_SECRET||"";
  if(!saas||!secret)return;
  const response=await fetch(`${saas}/v1/internal/n8n/deployments`,{
    method:"POST",
    headers:{authorization:`Bearer ${secret}`,"content-type":"application/json"},
    body:JSON.stringify(record),
  });
  if(!response.ok){
    const body=await response.text().catch(()=>"");
    throw new Error(`SaaS deployment metadata write failed: ${response.status} ${body}`);
  }
}

const desired=[];
for(const entry of manifest.workflows){
  const source=JSON.parse(await readFile(path.join(root,entry.file),"utf8"));
  desired.push({entry,source,payload:workflowPayload(source),signatures:webhookSignatures(source)});
}

if(!apply){
  console.log(JSON.stringify({
    mode:"dry-run",
    bundleVersion:manifest.bundleVersion,
    apiContractVersion:manifest.apiContractVersion,
    minimumN8nVersion:manifest.minimumN8nVersion??null,
    environment,
    workflows:desired.map(({entry,source,signatures})=>({
      key:entry.key,name:source.name,file:entry.file,required:Boolean(entry.required),trigger:entry.trigger,webhookSignatures:signatures
    })),
    safety:{
      staging:"All workflows are created/updated before any activation occurs.",
      activeUpdate:"Changed active canonical workflows are refused to avoid in-place production mutation.",
      activationRollback:"Workflows activated by this command are deactivated if a later activation fails.",
      conflictRollback:"Stale or conflicting active SaaS workflows deactivated during cutover are reactivated if activation fails."
    },
    next:"Set N8N_API_URL and N8N_API_KEY, then run with --apply. Add --activate only after validation. Use --deactivate-conflicts for a reviewed cutover from an older active bundle."
  },null,2));
  process.exit(0);
}

let existing=await listWorkflows();
const staged=[];
for(const item of desired){
  const {entry,source,payload,signatures}=item;
  const matches=existing.filter((workflow)=>workflow.name===source.name);
  if(matches.length>1) throw new Error(`Multiple n8n workflows have the name "${source.name}". Resolve duplicates before deployment.`);
  let remote=matches[0];
  let action="unchanged";
  if(!remote){
    remote=await n8n("/workflows",{method:"POST",body:JSON.stringify(payload)});
    existing.push(remote);
    action="created";
  }else{
    const full=remote.nodes?remote:await getWorkflow(remote.id);
    const remoteComparable=workflowPayload(full);
    if(!equal(payload,remoteComparable)){
      if(full.active){
        throw new Error(`Refusing to update active workflow "${source.name}" in place. Perform a blue/green cutover or deactivate the previous workflow before applying this bundle.`);
      }
      remote=await n8n(`/workflows/${encodeURIComponent(remote.id)}`,{method:"PUT",body:JSON.stringify(payload)});
      action="updated";
    }else{
      remote=full;
    }
  }
  staged.push({entry,source,remote,action,signatures});
}

const activatedThisRun=[];
const deactivatedConflicts=[];
try{
  if(activate){
    // Preflight all required targets before changing trigger state.
    const required=staged.filter(({entry})=>Boolean(entry.required));
    const targetIds=new Set(staged.map(({remote})=>String(remote.id)));
    const activeCandidates=existing.filter((workflow)=>workflow.active && !targetIds.has(String(workflow.id)) && String(workflow.name||"").startsWith("SaaS -"));
    const activeFull=[];
    for(const candidate of activeCandidates){
      activeFull.push(candidate.nodes?candidate:await getWorkflow(candidate.id));
    }

    const webhookConflicts=[];
    for(const target of required){
      for(const signature of target.signatures){
        for(const candidate of activeFull){
          if(webhookSignatures(candidate).includes(signature)){
            webhookConflicts.push({target,conflict:candidate,signature});
          }
        }
      }
    }

    // Any active managed SaaS workflow outside the desired bundle is stale during a bundle cutover.
    // This is intentionally broader than webhook conflict detection so old follow-up/maintenance/
    // heartbeat schedules cannot remain active and execute alongside the new bundle.
    const staleManaged=activeFull;
    if(staleManaged.length && !deactivateConflicts){
      const details=staleManaged.map((workflow)=>`${workflow.name}#${workflow.id}`).join(", ");
      const webhookDetails=webhookConflicts.length
        ? ` Webhook conflicts: ${webhookConflicts.map((x)=>`${x.signature} -> ${x.conflict.name}#${x.conflict.id}`).join(", ")}.`
        : "";
      throw new Error(`Active stale/conflicting SaaS workflows detected: ${details}.${webhookDetails} Re-run with --deactivate-conflicts only after reviewing the cutover.`);
    }

    // Deactivate all stale managed workflows only after the entire target bundle staged successfully.
    // Rollback below restores them if target activation fails.
    const uniqueConflicts=[...new Map(staleManaged.map((workflow)=>[String(workflow.id),workflow])).values()];
    for(const conflict of uniqueConflicts){
      await n8n(`/workflows/${encodeURIComponent(conflict.id)}/deactivate`,{method:"POST"});
      deactivatedConflicts.push(conflict);
    }

    // Activation is deliberately a second phase. Rollback below prevents a half-activated bundle.
    for(const target of required){
      if(!target.remote.active){
        target.remote=await n8n(`/workflows/${encodeURIComponent(target.remote.id)}/activate`,{method:"POST"});
        activatedThisRun.push(target.remote);
        target.action=target.action==="unchanged"?"activated":`${target.action}+activated`;
      }
    }
  }
}catch(error){
  const rollbackErrors=[];
  for(const workflow of [...activatedThisRun].reverse()){
    try{await n8n(`/workflows/${encodeURIComponent(workflow.id)}/deactivate`,{method:"POST"});}
    catch(rollbackError){rollbackErrors.push(`deactivate ${workflow.id}: ${rollbackError instanceof Error?rollbackError.message:String(rollbackError)}`);}
  }
  for(const workflow of deactivatedConflicts){
    try{await n8n(`/workflows/${encodeURIComponent(workflow.id)}/activate`,{method:"POST"});}
    catch(rollbackError){rollbackErrors.push(`reactivate ${workflow.id}: ${rollbackError instanceof Error?rollbackError.message:String(rollbackError)}`);}
  }
  if(rollbackErrors.length){
    throw new Error(`${error instanceof Error?error.message:String(error)}; activation rollback also reported: ${rollbackErrors.join("; ")}`);
  }
  throw error;
}

const results=[];
for(const target of staged){
  const record={
    environment,
    bundleVersion:manifest.bundleVersion,
    apiContractVersion:manifest.apiContractVersion,
    workflowKey:target.entry.key,
    workflowName:target.source.name,
    n8nWorkflowId:String(target.remote.id),
    logicalVersion:target.source.versionId || null,
    active:Boolean(target.remote.active || (activate && target.entry.required)),
    deploymentStatus:Boolean(target.remote.active || (activate && target.entry.required))?"active":"deployed",
    metadata:{
      file:target.entry.file,
      action:target.action,
      required:Boolean(target.entry.required),
      trigger:target.entry.trigger,
      webhookSignatures:target.signatures,
      deactivatedConflicts:deactivatedConflicts.map((workflow)=>({id:String(workflow.id),name:workflow.name}))
    },
  };
  await recordDeployment(record);
  results.push({...record,action:target.action});
}
console.log(JSON.stringify({
  mode:"apply",environment,bundleVersion:manifest.bundleVersion,
  activation:{requested:activate,activatedThisRun:activatedThisRun.map((workflow)=>String(workflow.id)),deactivatedConflicts:deactivatedConflicts.map((workflow)=>String(workflow.id))},
  results
},null,2));