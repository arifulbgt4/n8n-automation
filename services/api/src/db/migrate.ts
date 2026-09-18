import { migrate } from "drizzle-orm/node-postgres/migrator";
import { loadConfig } from "@n8nauto/config";
import { createDatabase } from "./client.js";

const config = loadConfig();
const { db, pool } = createDatabase(config);

try {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  console.info("Application database migrations completed.");
} finally {
  await pool.end();
}
