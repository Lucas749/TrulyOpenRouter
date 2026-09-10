import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureHostKey, run } from "../src/run.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { api, sh } from "../src/util.js";

const chain = vi.hoisted(() => ({
  getBalance: vi.fn(),
  readContract: vi.fn(),
  writeContract: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: () => chain,
  createWalletClient: () => chain,
}));
vi.mock("../src/util.js", () => ({ api: vi.fn(), sh: vi.fn() }));

describe("run registration funding", () => {
  const HBAR = 10n ** 18n;
  const options = { gateway: "http://gw:4121", model: "qwen2.5:0.5b", region: "us-oregon" };
  let home: string;
  let address: string;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    home = mkdtempSync(join(tmpdir(), "tor-run-"));
    vi.stubEnv("TOR_HOME", home);
    address = ensureHostKey(options.gateway).address;
    saveConfig({ ...loadConfig(), userId: "test-owner" });
    vi.mocked(sh).mockResolvedValue({ ok: true, out: "test-output" });
    vi.mocked(api).mockResolvedValue({
      rpcUrl: "http://rpc.invalid", registry: `0x${"1".repeat(40)}`, chain: "testnet",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ models: [{ name: options.model }] }),
    }));
    chain.getBalance.mockResolvedValue(6n * HBAR);
    chain.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "getHost" ? { active: false, stake: 0n } : 1n);
    chain.writeContract.mockResolvedValue(`0x${"a".repeat(64)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("resumes an active host with no liquid balance through guard startup and owner claim", async () => {
    chain.readContract.mockResolvedValue({ active: true, stake: 5n * HBAR });
    chain.getBalance.mockResolvedValue(0n);

    await run(options);

    expect(chain.writeContract.mock.calls).toHaveLength(0);
    expect(vi.mocked(sh).mock.calls.some(([, args]) => args.slice(-3).join(" ") === "up -d guard")).toBe(true);
    expect(vi.mocked(api).mock.calls).toContainEqual([
      options.gateway, `/api/hosts/${address}/owner`,
      { method: "POST", body: JSON.stringify({ userId: "test-owner" }) },
    ]);
  });

  it("still requires gas headroom when registering an inactive host", async () => {
    chain.getBalance.mockResolvedValue(5n * HBAR);

    await expect(run(options)).rejects.toThrow(`underfunded: send ≥ 1 HBAR testnet to ${address}`);
    expect(chain.writeContract.mock.calls).toHaveLength(0);
  });

  it("stakes once when an inactive host has enough balance", async () => {
    await run(options);

    expect(chain.writeContract.mock.calls).toHaveLength(1);
    expect(chain.writeContract.mock.calls[0][0]).toMatchObject({ functionName: "register", value: 5n * HBAR });
  });
});
