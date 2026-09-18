import fs from "node:fs";
import path from "node:path";

const root = path.resolve("automation/n8n");
if (!fs.existsSync(root)) {
  console.log("No n8n artifact directory yet; skipping workflow JSON validation.");
  process.exit(0);
}

for (const file of fs.readdirSync(root, { recursive: true })) {
  if (typeof file !== "string" || !file.endsWith(".json")) continue;
  const fullPath = path.join(root, file);
  JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

console.log("n8n JSON artifacts are syntactically valid.");
