import { db, dbEnabled, ensureSchema } from "./db";
import { join } from "path";

// Test isolation across backends: file mode uses TOR_MEMBERS_DIR (set by the
// caller); PG mode shares one database across parallel test files, so reset
// ONLY the given org ids, never truncate whole tables (that wipes a sibling
// file's rows mid-test).
export async function resetMembersDb(orgIds: string[]): Promise<void> {
  if (!dbEnabled()) return;
  await ensureSchema(join(process.cwd(), "schema.sql"));
  const q = db();
  await q.query(`DELETE FROM increase_requests WHERE org_id = ANY($1)`, [orgIds]);
  await q.query(`DELETE FROM rule_changes WHERE org_id = ANY($1)`, [orgIds]);
  await q.query(`DELETE FROM team_members WHERE org_id = ANY($1)`, [orgIds]);
  await q.query(`DELETE FROM team_orgs WHERE id = ANY($1)`, [orgIds]);
  await q.query(`DELETE FROM team_org_rules WHERE org_id = ANY($1)`, [orgIds]);
}
