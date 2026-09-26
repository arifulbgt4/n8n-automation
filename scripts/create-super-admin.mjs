import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(scryptCallback);
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = String(process.env.ADMIN_PASSWORD || "");
const name = String(process.env.ADMIN_NAME || "Super Admin").trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!email || !email.includes("@")) throw new Error("ADMIN_EMAIL is required");
if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
  throw new Error("ADMIN_PASSWORD must be at least 12 characters and contain letters and numbers");
}

async function hashPassword(value) {
  const salt = randomBytes(16);
  const derived = await scrypt(value, salt, 64);
  return `scrypt-v1$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

const pool = new Pool({ connectionString: databaseUrl, application_name: "n8n-automation-admin-bootstrap" });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  let user = await client.query("SELECT id FROM users WHERE email=$1 FOR UPDATE", [email]);
  const passwordHash = await hashPassword(password);
  if (!user.rows[0]) {
    user = await client.query(`
      INSERT INTO users(email,password_hash,name,status,email_verified_at)
      VALUES ($1,$2,$3,'active',now()) RETURNING id
    `, [email, passwordHash, name]);
  }
  const adminCredential = await client.query("SELECT id FROM auth_credentials WHERE user_id=$1 AND realm='admin'", [user.rows[0].id]);
  if (!adminCredential.rows[0]) {
    await client.query(`
      INSERT INTO auth_credentials(user_id,realm,email,password_hash)
      VALUES ($1,'admin',$2,$3)
    `, [user.rows[0].id, email, passwordHash]);
  } else if (process.env.ADMIN_RESET_PASSWORD === "true") {
    await client.query("UPDATE auth_credentials SET password_hash=$2,updated_at=now() WHERE user_id=$1 AND realm='admin'", [user.rows[0].id, passwordHash]);
  }
  if (process.env.ADMIN_RESET_PASSWORD === "true") {
    await client.query("UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND auth_realm='admin' AND revoked_at IS NULL", [user.rows[0].id]);
  }
  await client.query(`
    INSERT INTO platform_admins(user_id,role,active)
    VALUES ($1,'SUPER_ADMIN',true)
    ON CONFLICT(user_id) DO UPDATE SET
      role='SUPER_ADMIN',
      active=true,
      updated_at=now()
  `, [user.rows[0].id]);
  await client.query("COMMIT");
  console.log(`Super admin ready: ${email}. Sign in with email and password.`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
