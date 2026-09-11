import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("../src/util.js", () => ({ sh: vi.fn() }));
import { sh } from "../src/util.js";
import { rememberTunnel } from "../src/host-tunnel.js";

describe("tunnel replacement", () => {
  let dir: string;
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  it("retires the previous verified process when adopting a new tunnel", async () => {
    dir = mkdtempSync(join(tmpdir(), "tor-tunnel-"));
    vi.stubEnv("TOR_HOME", dir);
    const running = new Set([50001, 50002]);
    vi.mocked(sh).mockImplementation(async (_cmd, args) => ({ ok: running.has(Number(args[1])), out: `started-${args[1]} cloudflared tunnel --url http://127.0.0.1:4122` }));
    const kill = vi.spyOn(process, "kill").mockImplementation(pid => { running.delete(pid); return true; });
    await rememberTunnel(50001, join(dir, "old.log"));
    await rememberTunnel(50002, join(dir, "new.log"));
    expect(kill.mock.calls).toEqual([[50001, "SIGTERM"]]);
    expect(JSON.parse(readFileSync(join(dir, "tunnel.json"), "utf8")).pid).toBe(50002);
    await rememberTunnel(50002, join(dir, "new.log"));
    expect(kill.mock.calls).toHaveLength(1);
  });
});
