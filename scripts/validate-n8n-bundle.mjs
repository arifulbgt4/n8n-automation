import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root=path.resolve("automation/n8n");
const manifest=JSON.parse(await readFile(path.join(root,"manifest.json"),"utf8"));
if(!manifest.bundleVersion || !manifest.apiContractVersion || !Array.isArray(manifest.workflows)) throw new Error("Invalid n8n manifest");
const keys=new Set();
for(const entry of manifest.workflows){
  if(!entry.key || !entry.file) throw new Error("Workflow manifest entry requires key and file");
  if(keys.has(entry.key)) throw new Error(`Duplicate workflow key ${entry.key}`);
  keys.add(entry.key);
  const full=path.join(root,entry.file);
  const raw=await readFile(full,"utf8");
  const workflow=JSON.parse(raw);
  if(workflow.active!==false) throw new Error(`${entry.file}: committed workflows must be inactive`);
  if(!Array.isArray(workflow.nodes)||!workflow.nodes.length) throw new Error(`${entry.file}: workflow has no nodes`);
  const forbidden=[
    /ms_live_[A-Za-z0-9_-]+/i,
    /sk-[A-Za-z0-9_-]{16,}/i,
    /Bearer\s+[A-Za-z0-9._-]{20,}/i,
    /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/i,
    /redis(?:s)?:\/\/[^\s"']+:[^\s"']+@/i,
    /https?:\/\/(?:admin\.)?openmusk\.store/i,
  ];
  for(const pattern of forbidden) if(pattern.test(raw)) throw new Error(`${entry.file}: contains a forbidden secret/infrastructure literal matching ${pattern}`);
  if(raw.includes("localhost")||raw.includes("127.0.0.1")) throw new Error(`${entry.file}: contains a hard-coded local endpoint`);
}
const workflowDir=path.join(root,"workflows");
const files=(await readdir(workflowDir)).filter((name)=>name.endsWith(".json")).sort();
const manifested=manifest.workflows.map((entry)=>path.basename(entry.file)).sort();
if(JSON.stringify(files)!==JSON.stringify(manifested)) throw new Error("Manifest workflow files do not exactly match automation/n8n/workflows");
console.log(`Validated n8n bundle ${manifest.bundleVersion}: ${files.length} workflows`);
