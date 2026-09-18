import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const statusOnly = process.argv.includes("--status");
const migrationsDir = path.resolve("database/migrations");
const pool = new Pool({ connectionString: databaseUrl, application_name: "n8n-automation-migrate" });

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const appliedResult = await pool.query("SELECT version, applied_at FROM schema_migrations ORDER BY version");
  const applied = new Map(appliedResult.rows.map((row) => [row.version, row.applied_at]));

  if (statusOnly) {
    for (const file of files) {
      console.log(`${applied.has(file) ? "applied" : "pending"}\t${file}${applied.has(file) ? `\t${applied.get(file).toISOString?.() ?? applied.get(file)}` : ""}`);
    }
    process.exit(0);
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    console.log(`Applying ${file}...`);
    const client = await pool.connect();
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
    } finally {
      client.release();
    }
    console.log(`Applied ${file}`);
  }
} finally {
  await pool.end();
}
