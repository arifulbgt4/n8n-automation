import fs from "node:fs";
import path from "node:path";

const docsDir = path.resolve("docs");
const required = [
  "README.md",
  "00_MASTER_PLAN.md",
  "14_IMPLEMENTATION_ROADMAP.md",
  "15_TESTING_ACCEPTANCE.md",
  "17_EXISTING_INFRA_AND_WORKFLOW_DELIVERY.md",
  "18_IMPLEMENTATION_DECISIONS.md"
];

for (const file of required) {
  const fullPath = path.join(docsDir, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required documentation file: ${file}`);
  }
  const content = fs.readFileSync(fullPath, "utf8");
  if (!content.trim()) throw new Error(`Documentation file is empty: ${file}`);
}

console.log(`Validated ${required.length} required documentation files.`);
