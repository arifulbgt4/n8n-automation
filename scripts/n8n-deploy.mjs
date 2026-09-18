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
  return {
    name:source.name,
    nodes:source.nodes,
    connections:source.connections ?? {},
    settings:source.settings ?? {},
    staticData:source.staticData ?? null,
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
  desired.push({entry,source,payload:workflowPayload(source)});
}

if(!apply){
  console.log(JSON.stringify({
    mode:"dry-run",
    bundleVersion:manifest.bundleVersion,
    apiContractVersion:manifest.apiContractVersion,
    environment,
    workflows:desired.map(({entry,source})=>({key:entry.key,name:source.name,file:entry.file,required:Boolean(entry.required),trigger:entry.trigger})),
    next:"Set N8N_API_URL and N8N_API_KEY, then run with --apply. Add --activate only after validation."
  },null,2));
  process.exit(0);
}

let existing=await listWorkflows();
const results=[];
for(const {entry,source,payload} of desired){
  const matches=existing.filter((workflow)=>workflow.name===source.name);
  if(matches.length>1) throw new Error(`Multiple n8n workflows have the name "${source.name}". Resolve duplicates before deployment.`);
  let remote=matches[0];
  let action="unchanged";
  if(!remote){
    remote=await n8n("/workflows",{method:"POST",body:JSON.stringify(payload)});
    existing.push(remote); action="created";
  }else{
    const remoteComparable=workflowPayload(remote);
    if(!equal(payload,remoteComparable)){
      remote=await n8n(`/workflows/${encodeURIComponent(remote.id)}`,{method:"PUT",body:JSON.stringify(payload)});
      action="updated";
    }
  }

  if(activate && entry.required && !remote.active){
    remote=await n8n(`/workflows/${encodeURIComponent(remote.id)}/activate`,{method:"POST"});
    action=action==="unchanged"?"activated":`${action}+activated`;
  }

  if(deactivateConflicts){
    const prefix="SaaS - ";
    const conflicts=existing.filter((workflow)=>workflow.id!==remote.id && workflow.name?.startsWith(prefix) && workflow.name===source.name && workflow.active);
    for(const conflict of conflicts) await n8n(`/workflows/${encodeURIComponent(conflict.id)}/deactivate`,{method:"POST"});
  }

  const record={
    environment,
    bundleVersion:manifest.bundleVersion,
    apiContractVersion:manifest.apiContractVersion,
    workflowKey:entry.key,
    workflowName:source.name,
    n8nWorkflowId:String(remote.id),
    logicalVersion:source.versionId || null,
    active:Boolean(remote.active || (activate && entry.required)),
    deploymentStatus:Boolean(remote.active || (activate && entry.required))?"active":"deployed",
    metadata:{file:entry.file,action,required:Boolean(entry.required),trigger:entry.trigger},
  };
  await recordDeployment(record);
  results.push({...record,action});
}
console.log(JSON.stringify({mode:"apply",environment,bundleVersion:manifest.bundleVersion,results},null,2));
