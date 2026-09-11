import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { createApp } from "../src/index.js";
import { normalizeSnapshot, PgTeams, TeamError } from "../src/teams.js";

const A = `0x${"a1".repeat(20)}`;
const B = `0x${"b2".repeat(20)}`;

describe("team snapshot validation", () => {
  it("rejects malformed members before storage and lowercases wallets", () => {
    expect(() => normalizeSnapshot("org", { members: [{ did: "", role: "owner", status: "active" }] })).toThrow(TeamError);
    expect(() => normalizeSnapshot("org", { members: [{ did: "d", role: "admin", status: "active" }] })).toThrow("role");
    expect(() => normalizeSnapshot("org", { members: [{ did: "d", role: "owner", status: "active", wallet: "nope" }] })).toThrow("wallet");
    expect(() => normalizeSnapshot("org", { members: [{ did: "d", role: "owner", status: "active", allowanceCredits: -1 }] })).toThrow("allowance");
    expect(() => normalizeSnapshot("org", { members: [{ did: "d", role: "owner", status: "active" }, { did: "d", role: "member", status: "active" }] })).toThrow("duplicate");
    const s = normalizeSnapshot("org", { defaultAllowanceCredits: 10, members: [{ did: "d", role: "owner", status: "active", wallet: `0x${"A1".repeat(20)}` }] });
    expect(s.members[0]).toEqual({ did: "d", wallet: A, email: null, role: "owner", status: "active", allowanceCredits: null });
  });

  it("accepts snapshots only through the private admin hop", async () => {
    const applySnapshot = vi.fn().mockResolvedValue({ revision: 1, changed: true, removed: [] });
    const server = createApp({ requireSubscription: false, adminToken: "private-admin", teams: { applySnapshot } as any }).listen(0);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/admin/teams/org-1/snapshot`;
    const post = (auth: string, body: unknown) => fetch(url, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    try {
      expect((await post("", { members: [] })).status).toBe(401);
      expect((await post("Bearer private-admin", { members: [{ did: "d", role: "root", status: "active" }] })).status).toBe(400);
      expect(applySnapshot).not.toHaveBeenCalled();
      const ok = await post("Bearer private-admin", { orgId: "forged", members: [{ did: "d", role: "owner", status: "active" }] });
      expect(ok.status).toBe(200);
      expect(applySnapshot.mock.calls[0][0]).toMatchObject({ orgId: "org-1" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Use a disposable database. Never point TEST_DATABASE_URL at production.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;
integration("team membership mirror", () => {
  const pool = new Pool({ connectionString: database });
  const teams = new PgTeams(pool);
  const snapshot = (orgId: string, members: unknown[], extra: Record<string, unknown> = {}) => normalizeSnapshot(orgId, { defaultAllowanceCredits: 100, members, ...extra });

  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`DELETE FROM team_finance WHERE org_id LIKE 'test-%'`);
  });
  afterAll(async () => {
    await pool.end();
  });

  it("applies snapshots with revisions and keeps removed history", async () => {
    const owner = { did: "did:owner", wallet: A, role: "owner", status: "active" };
    const member = { did: "did:m", wallet: B, role: "member", status: "active", allowanceCredits: 50 };
    expect(await teams.applySnapshot(snapshot("test-org", [owner, member], { name: "Acme" }))).toEqual({ revision: 1, changed: true, removed: [] });
    expect(await teams.applySnapshot(snapshot("test-org", [owner, member], { name: "Acme" }))).toEqual({ revision: 1, changed: false, removed: [] });
    expect(await teams.applySnapshot(snapshot("test-org", [owner], { name: "Acme" }))).toEqual({ revision: 2, changed: true, removed: ["did:m"] });
    expect((await teams.members("test-org")).find((m) => m.did === "did:m")).toMatchObject({ status: "removed", allowanceCredits: 50 });
    expect(await teams.memberFor("test-org", { userId: "did:nobody", wallets: [B] })).toBeNull();
    expect(await teams.team("test-org")).toMatchObject({ name: "Acme", state: "pending", defaultAllowanceCredits: 100, membershipRevision: 2, walletAddress: null });
    // An allowance edit is a membership change that advances the revision.
    expect((await teams.applySnapshot(snapshot("test-org", [{ ...owner, allowanceCredits: 5 }], { name: "Acme" }))).revision).toBe(3);
  });

  it("resolves membership by verified subject or linked wallet without crossing teams", async () => {
    await teams.applySnapshot(snapshot("test-a", [{ did: "did:owner", wallet: A, role: "owner", status: "active" }, { did: "email:new@example.com", email: "new@example.com", role: "member", status: "invited" }]));
    await teams.applySnapshot(snapshot("test-b", [{ did: "did:other", wallet: B, role: "member", status: "active" }]));
    expect((await teams.memberFor("test-a", { userId: "did:owner", wallets: [] }))?.role).toBe("owner");
    expect((await teams.memberFor("test-a", { userId: "did:someone", wallets: [A.toUpperCase().replace("0X", "0x")] }))?.did).toBe("did:owner");
    expect(await teams.memberFor("test-a", { userId: "did:other", wallets: [B] })).toBeNull();
    expect(await teams.memberFor("test-a", { userId: "email:new@example.com", wallets: [] })).toBeNull();
    expect((await teams.teamsFor({ userId: "did:other", wallets: [] })).map((t) => t.orgId)).toEqual(["test-b"]);
  });

  it("serializes concurrent snapshots so revisions never skip or repeat", async () => {
    const owner = { did: "did:owner", wallet: A, role: "owner", status: "active" };
    await teams.applySnapshot(snapshot("test-race", [owner]));
    const results = await Promise.all([1, 2, 3, 4].map((n) => teams.applySnapshot(snapshot("test-race", [{ ...owner, allowanceCredits: n }]))));
    expect(results.map((r) => r.revision).sort()).toEqual([2, 3, 4, 5]);
  });
});
