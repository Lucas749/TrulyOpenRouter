import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureHostKey, run } from "../src/run.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { api, sh } from "../src/util.js";

const chain = vi.hoisted(() => ({
  getBalance: vi.fn(),
  readContract: vi.fn(),
  writeContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
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
      rpcUrl: "http://rpc.invalid", registry: `0x${"1".repeat(40)}`, chain: "testnet", chainId: 296,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: async () => ({ models: [{ name: options.model }] }),
    }));
    chain.getBalance.mockResolvedValue(5n * HBAR);
    chain.readContract.mockImplementation(async ({ functionName }) =>
      functionName === "getHost" ? { active: false, stake: 0n } : 400_000_000n);
    chain.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    chain.writeContract.mockResolvedValue(`0x${"a".repeat(64)}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("resumes an active host with no liquid balance through guard startup and owner claim", async () => {
    chain.readContract.mockResolvedValue({ active: true, stake: 1_000_000_000n });
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
    chain.getBalance.mockResolvedValue(4n * HBAR);

    await expect(run(options)).rejects.toThrow("Add 1 testnet HBAR to your host wallet");
    expect(chain.writeContract.mock.calls).toHaveLength(0);
  });

  it("resumes a legacy host without funding the replacement registry", async () => {
    const legacy = `0x${"2".repeat(40)}`;
    vi.mocked(api).mockResolvedValue({ rpcUrl: "http://rpc.invalid", registry: `0x${"1".repeat(40)}`, chainId: 296, legacyRegistries: [legacy] });
    chain.readContract.mockImplementation(async ({ address: registry }) => ({ active: registry === legacy, stake: registry === legacy ? 1_000_000_000n : 0n }));
    chain.getBalance.mockResolvedValue(0n);
    await run(options);
    expect(chain.writeContract.mock.calls).toHaveLength(0);
    expect(loadConfig().hostRegistry).toBe(legacy);
  });

  it("writes the actual funding target for quickstart", async () => {
    chain.getBalance.mockResolvedValue(4n * HBAR);
    const statusFile = join(home, "run.json");
    await expect(run({ ...options, statusFile })).rejects.toThrow("Add 1 testnet HBAR");
    expect(JSON.parse(readFileSync(statusFile, "utf8"))).toMatchObject({
      kind: "needs_funds", address, stakeHbar: "4", totalHbar: "5", totalWei: String(5n * HBAR),
    });
  });

  it("does not register when reading the current host fails", async () => {
    chain.readContract.mockRejectedValue(new Error("RPC unavailable"));
    await expect(run(options)).rejects.toThrow("RPC unavailable");
    expect(chain.writeContract.mock.calls).toHaveLength(0);
  });

  it("does not report a reverted transaction as a successful registration", async () => {
    chain.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(run(options)).rejects.toThrow("Registration transaction reverted");
    expect(vi.mocked(sh).mock.calls.some(([, args]) => args.slice(-3).join(" ") === "up -d guard")).toBe(false);
  });

  it("registers with exactly 5 HBAR overall and leaves gas reserve", async () => {
    await run(options);

    expect(chain.writeContract.mock.calls).toHaveLength(1);
    expect(chain.writeContract.mock.calls[0][0]).toMatchObject({ functionName: "register", value: 4n * HBAR });
  });
});
