import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enableGuardPayments } from "../src/guard-payment.js";

describe("paid host setup", () => {
  const dirs: string[] = [];
  const address = `0x${"12".repeat(20)}`;
  const directory = () => { const dir = mkdtempSync(join(tmpdir(), "tor-payment-")); dirs.push(dir); return dir; };
  afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
  it("uses the host's native payee and preserves unrelated compose settings", async () => {
    const dir = directory();
    writeFileSync(join(dir, ".env"), "UPSTREAM_URL=http://ollama:11434\nHOST_WALLET=old\n");
    const fetcher = vi.fn(async () => Response.json({ account: "0.0.123", evm_address: address }));
    const shell = vi.fn(async () => ({ ok: true, out: "" }));
    expect(await enableGuardPayments(address, join(dir, "docker-compose.yml"), fetcher, shell)).toBe("0.0.123");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("UPSTREAM_URL=http://ollama:11434\nHOST_WALLET=0.0.123\n");
    expect(shell.mock.calls[0][2].env.HOST_WALLET).toBe("0.0.123");
  });
  it("does not start a free guard when account resolution fails or mismatches", async () => {
    const dir = directory(), shell = vi.fn(async () => ({ ok: true, out: "" }));
    const fetcher = vi.fn(async () => Response.json({ account: "0.0.123", evm_address: `0x${"34".repeat(20)}` }));
    await expect(enableGuardPayments(address, join(dir, "docker-compose.yml"), fetcher, shell)).rejects.toThrow("not visible");
    expect(shell.mock.calls).toHaveLength(0);
  });
});
