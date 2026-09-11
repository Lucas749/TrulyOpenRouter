import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

// Use a disposable database. Never point TEST_DATABASE_URL at production.
// Each case applies web/schema.sql inside its own throwaway Postgres schema.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

integration("web schema", () => {
  const admin = new Pool({ connectionString: database, max: 1 });
  const opened: Array<{ name: string; pool: Pool }> = [];
  const scratch = async () => {
    const name = `web_schema_${Date.now().toString(36)}_${opened.length}`;
    await admin.query(`CREATE SCHEMA ${name}`);
    const url = new URL(database!);
    url.searchParams.set("options", `-c search_path=${name}`);
    const pool = new Pool({ connectionString: url.toString(), max: 1 });
    opened.push({ name, pool });
    return pool;
  };
  const columns = async (pool: Pool) =>
    (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'team_orgs'`)).rows.map((r) => r.column_name);

  afterAll(async () => {
    for (const { name, pool } of opened) {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    }
    await admin.end();
  });

  it("creates team_orgs with the period_days column the app writes", async () => {
    const pool = await scratch();
    await pool.query(schemaSql);
    expect(await columns(pool)).toEqual(expect.arrayContaining(["period_days", "creator_wallet"]));
    expect(await columns(pool)).not.toContain("perioddays");
    await pool.query(`INSERT INTO team_orgs (id, default_allowance_credits, period_days, creator_wallet) VALUES ('fresh', null, 30, null)`);
  });

  it("renames a legacy perioddays column once and keeps existing rows", async () => {
    const pool = await scratch();
    await pool.query(`CREATE TABLE team_orgs (id text PRIMARY KEY, default_allowance_credits double precision, periodDays int NOT NULL DEFAULT 30)`);
    await pool.query(`INSERT INTO team_orgs (id, periodDays) VALUES ('legacy', 14)`);
    await pool.query(schemaSql);
    await pool.query(schemaSql);
    expect(await columns(pool)).toContain("period_days");
    expect(await columns(pool)).not.toContain("perioddays");
    expect((await pool.query(`SELECT period_days FROM team_orgs WHERE id = 'legacy'`)).rows[0].period_days).toBe(14);
  });
});
