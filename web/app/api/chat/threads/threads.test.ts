import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db, dbEnabled, ensureSchema } from "../../../../lib/db";
import { listThreads, saveThreads } from "../../../../lib/chat-threads";
import { GET as listRoute, POST as saveRoute } from "./route";

(process.env.DATABASE_URL ? describe : describe.skip)("chat threads on postgres", () => {
  it("roundtrips server history", async () => {
    await ensureSchema(join(process.cwd(), "schema.sql"));
    const u = `0xpg${Date.now().toString(36)}`;
    await db().query(`DELETE FROM chat_messages WHERE user_handle = $1`, [u]);
    await db().query(`DELETE FROM chat_threads WHERE user_handle = $1`, [u]);
    await saveThreads(u, [
      { id: "t1", title: "pg thread", updatedAt: 9, msgs: [{ role: "user", content: "hi", ts: 9, receipt: "0xabc", settled: true }] },
    ]);
    const got = await listThreads(u);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "t1", title: "pg thread" });
    expect(got[0].msgs[0]).toMatchObject({ role: "user", content: "hi", receipt: "0xabc", settled: true });
    expect(await listThreads(u + "-nobody")).toEqual([]);
    await db().query(`DELETE FROM chat_messages WHERE user_handle = $1`, [u]);
    await db().query(`DELETE FROM chat_threads WHERE user_handle = $1`, [u]);
  });
});

describe("chat threads", () => {
  it("roundtrips per-user threads (file backend)", async () => {
    process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-threads-"));
    delete process.env.DATABASE_URL;
    await saveThreads("0xU", [{ id: "t1", title: "hi", updatedAt: 5, msgs: [{ role: "user", content: "yo", ts: 5 }] }]);
    expect(await listThreads("0xU")).toMatchObject([{ id: "t1", title: "hi" }]);
    expect(await listThreads("0xOTHER")).toEqual([]);
    expect(await listThreads("")).toEqual([]);
  });

  it("routes validate + clamp", async () => {
    process.env.TOR_MEMBERS_DIR = mkdtempSync(join(tmpdir(), "tor-threads-"));
    delete process.env.DATABASE_URL;
    const bad = await saveRoute(new Request("http://x", { method: "POST", body: JSON.stringify({}) }));
    expect(bad.status).toBe(400);
    const evil = await saveRoute(
      new Request("http://x", { method: "POST", body: JSON.stringify({ user: "0xU", threads: [{ id: "t", title: "x".repeat(200), msgs: [{ role: "sys", content: "y".repeat(50000) }] }] }) }),
    );
    expect(evil.status).toBe(200);
    const listed: any = await (await listRoute(new Request("http://x/api/chat/threads?user=0xU"))).json();
    expect(listed.threads[0].title).toHaveLength(80);
    expect(listed.threads[0].msgs[0].role).toBe("user");
    expect(listed.threads[0].msgs[0].content).toHaveLength(20000);
  });
});
