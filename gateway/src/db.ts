import { readFileSync } from "fs";
import { join } from "path";
import { Pool } from "pg";

// Postgres when DATABASE_URL is set, otherwise current behavior (memory/files).
// Schema auto-applies once per process (CREATE TABLE IF NOT EXISTS only).

let pool: Pool | null = null;
let schemaDone = false;

export function dbEnabled(): boolean {
  return !!process.env.DATABASE_URL;
}

export function db(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
    pool.on("error", (e) => console.error(`pg pool: ${String(e?.message ?? e).slice(0, 160)}`));
  }
  return pool;
}

export async function ensureSchema(schemaFile = join(process.cwd(), "schema.sql")): Promise<void> {
  if (schemaDone) return;
  const sql = readFileSync(schemaFile, "utf8");
  await db().query(sql);
  schemaDone = true;
}
