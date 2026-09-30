import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const stages = [
  { workspace: "apps/api", tsx: true },
  { workspace: "apps/worker", tsx: true },
  { workspace: "packages/core", tsx: false },
  { workspace: "customer-panel", tsx: true },
];

for (const stage of stages) {
  const files = readdirSync(join(stage.workspace,"test"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join("test",name));
  if (!files.length) continue;
  const args = [...(stage.tsx ? ["--import","tsx"] : []),"--test",...files];
  const result = spawnSync(process.execPath,args,{
    cwd:join(process.cwd(),stage.workspace),
    stdio:"inherit",
    env:process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
