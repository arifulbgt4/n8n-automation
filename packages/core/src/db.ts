import pg from "pg";
import { env } from "./env.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      application_name: "n8n-automation-saas",
    });
    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error", error);
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return db().query<T>(text, values);
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function assertDatabaseReady(): Promise<void> {
  const result = await query<{ ok: number }>("SELECT 1 AS ok");
  if (result.rows[0]?.ok !== 1) throw new Error("PostgreSQL health check failed");
}
