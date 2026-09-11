import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Use a disposable database. Never point TEST_DATABASE_URL at production.
// Rule storage runs against its own throwaway schema. Each vitest file runs in its own
// process, so pointing DATABASE_URL at that schema here does not reach other test files.
const database = process.env.TEST_DATABASE_URL;
const integration = database ? describe : describe.skip;

integration("team rules in Postgres", () => {
  const schema = `web_rules_${Date.now().toString(36)}`;
  const admin = new Pool({ connectionString: database, max: 1 });
  const OWNER_A = privateKeyToAccount(generatePrivateKey());
  const OWNER_B = privateKeyToAccount(generatePrivateKey());
  let members: typeof import("./members");
  let messages: typeof import("./member-messages");

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(database!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    delete process.env.POSTGRES_URL;
    process.env.DATABASE_URL = url.toString();
    members = await import("./members");
    messages = await import("./member-messages");
  });

  afterAll(async () => {
    const { db } = await import("./db");
    await db().end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const decision = async (owner: typeof OWNER_A, id: string, orgId: string, payload: Record<string, unknown>, choice: "approve" | "deny") => {
    const message = messages.ruleDecisionMessage({ id, orgId, kind: "daily_cap", payloadJson: messages.stableJson(payload) }, choice, Date.now() + 300_000);
    return { message, signature: await owner.signMessage({ message }) };
  };

  it("keeps every team's writes when teams change rules at the same time", async () => {
    const pending = await members.proposeRuleChange("team-a", "daily_cap", { credits: 111 }, "did:privy:manager-a");
    const deny = await decision(OWNER_A, pending.id, "team-a", { credits: 111 }, "deny");
    const setMessage = messages.ruleSetMessage("team-b", "models", { models: ["m1"] }, Date.now() + 300_000);
    const setSignature = await OWNER_B.signMessage({ message: setMessage });
    await Promise.all([
      members.decideRuleChange(pending.id, "deny", "did:privy:owner-a", OWNER_A.address, deny.signature, deny.message),
      members.setRuleDirect("team-b", "models", { models: ["m1"] }, "did:privy:owner-b", OWNER_B.address, setSignature, setMessage),
      ...Array.from({ length: 6 }, (_, i) => members.proposeRuleChange("team-c", "rate_limit", { perMin: i + 1 }, "did:privy:manager-c")),
    ]);
    expect((await members.listRuleChanges("team-a"))[0]).toMatchObject({ status: "denied", decisionSigner: OWNER_A.address });
    expect((await members.getRules("team-b")).allowedModels).toEqual(["m1"]);
    expect(await members.listRuleChanges("team-c", "pending")).toHaveLength(6);
  });

  it("lets only one of two simultaneous decisions on the same change take effect", async () => {
    const change = await members.proposeRuleChange("team-d", "daily_cap", { credits: 5 }, "did:privy:manager-d");
    const approve = await decision(OWNER_A, change.id, "team-d", { credits: 5 }, "approve");
    const deny = await decision(OWNER_B, change.id, "team-d", { credits: 5 }, "deny");
    const results = await Promise.allSettled([
      members.decideRuleChange(change.id, "approve", "did:privy:owner-d", OWNER_A.address, approve.signature, approve.message),
      members.decideRuleChange(change.id, "deny", "did:privy:owner-d2", OWNER_B.address, deny.signature, deny.message),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const stored = (await members.listRuleChanges("team-d"))[0];
    expect((await members.getRules("team-d")).dailyCapCredits).toBe(stored.status === "approved" ? 5 : undefined);
  });
});
