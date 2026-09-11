import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseTransaction, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { acceptsTestUsdc, collectEarnings, HOST_GAS_RESERVE_WEI, linkTeam, TEST_USDC, TRANSFER_GAS } from "../src/team.js";

const api = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }>, responses: new Map<string, unknown>() }));
const withdraw = vi.hoisted(() => ({ quote: vi.fn(), submit: vi.fn() }));
vi.mock("../src/host-runtime.js", () => ({
  hostContext: vi.fn(),
  hostApi: vi.fn(async (_gateway: string, path: string, body?: unknown) => {
    api.calls.push({ path, body });
    const response = api.responses.get(path.split("?")[0]);
    if (response instanceof Error) throw response;
    return response ?? {};
  }),
}));
vi.mock("../src/host-registry.js", () => ({ findHostRegistry: vi.fn(async () => ({ registry: `0x${"e5".repeat(20)}`, host: {} })) }));
vi.mock("../src/withdraw.js", () => ({ quoteWithdrawal: withdraw.quote, submitWithdrawal: withdraw.submit }));

const HOST = privateKeyToAccount(`0x${"4".repeat(64)}`);
const REGISTRY = `0x${"e5".repeat(20)}`;
const VAULT = `0x${"d7".repeat(20)}` as const;
const TEAM = `0x${"c3".repeat(20)}`;
const GAS_PRICE = 710_000_000_000n;
const WITHDRAW_TX = `0x${"ab".repeat(32)}` as Hex;
const HBAR = 10n ** 18n;
const EVENTS = parseAbi(["event Withdrawn(address indexed host, uint256 amount)"]);
const link = { orgId: "org-1", teamName: "Acme", destination: TEAM, registry: REGISTRY, linkedAt: 1 };

function context() {
  const state = { balance: 3n * HBAR, nonce: 7, mine: true, revert: false, sent: [] as Hex[], receipts: new Map<string, { status: "success" | "reverted"; logs: unknown[] }>() };
  const publicClient = {
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = state.receipts.get(hash);
      if (!receipt) throw new Error("receipt not found");
      return receipt;
    }),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      state.sent.push(serializedTransaction);
      if (state.mine) state.receipts.set(keccak256(serializedTransaction), { status: state.revert ? "reverted" : "success", logs: [] });
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => {
      const receipt = state.receipts.get(hash);
      if (!receipt) throw new Error("timed out");
      return receipt;
    }),
    getTransactionCount: vi.fn(async () => state.nonce + state.receipts.size - 1),
    getGasPrice: vi.fn(async () => GAS_PRICE),
    getBalance: vi.fn(async () => state.balance),
    readContract: vi.fn(async () => 5_000n),
  };
  const ctx = { gateway: "https://gw.test", account: HOST, network: { vault: VAULT, registry: REGISTRY, legacyRegistries: [] }, publicClient } as any;
  return { ctx, state };
}

beforeEach(() => {
  process.env.TOR_HOME = mkdtempSync(join(tmpdir(), "tor-team-"));
  api.calls.length = 0;
  api.responses.clear();
  api.responses.set(`/api/hosts/${HOST.address}/team-link`, link);
  withdraw.quote.mockReset().mockResolvedValue({ address: HOST.address, vault: VAULT, credits: 900n, tinybar: 90_000_000n, gas: 120_000n, gasPrice: GAS_PRICE, maxFeeWei: 120_000n * GAS_PRICE });
  withdraw.submit.mockReset();
});

const withdrawal = (state: ReturnType<typeof context>["state"]) =>
  withdraw.submit.mockImplementation(async () => {
    state.receipts.set(WITHDRAW_TX, {
      status: "success",
      logs: [{ address: VAULT, topics: encodeEventTopics({ abi: EVENTS, eventName: "Withdrawn", args: { host: HOST.address } }), data: encodeAbiParameters([{ type: "uint256" }], [90_000_000n]) }],
    });
    return WITHDRAW_TX;
  });
const collections = () => api.calls.filter((c) => c.path.endsWith("/collections")).map((c) => c.body);

describe("team link", () => {
  const terms = (over: Partial<{ registry: string; host: string; code: string }> = {}) => ({
    orgId: "org-1", teamName: "Acme", destination: TEAM, registry: over.registry ?? REGISTRY, expiresAt: Date.now() + 60_000,
    message: ["TrulyOpenRouter host link", "origin: https://tor.test", "network: hedera-testnet (chain 296)", `registry: ${over.registry ?? REGISTRY}`, `host: ${over.host ?? HOST.address.toLowerCase()}`, "team: Acme (org-1)", `destination: ${TEAM}`, "action: collect this host's earnings only into the destination wallet", `nonce: ${over.code ?? "thl_abcdefgh"}`, "expires: 2031-01-01T00:00:00.000Z"].join("\n"),
  });

  it("signs only terms that name this host, its registry, and the code", async () => {
    const { ctx } = context();
    api.responses.set("/api/host-links/thl_abcdefgh", terms({ host: `0x${"99".repeat(20)}` }));
    await expect(linkTeam("thl_abcdefgh", ctx, async () => true)).rejects.toThrow("do not match");
    api.responses.set("/api/host-links/thl_abcdefgh", terms({ registry: `0x${"11".repeat(20)}` }));
    await expect(linkTeam("thl_abcdefgh", ctx, async () => true)).rejects.toThrow("do not match");
    expect(api.calls.some((c) => c.body)).toBe(false);

    api.responses.set("/api/host-links/thl_abcdefgh", terms());
    expect(await linkTeam("thl_abcdefgh", ctx, async () => false)).toContain("Nothing was signed");
    const good = terms();
    api.responses.set("/api/host-links/thl_abcdefgh", good);
    const result = await linkTeam("thl_abcdefgh", ctx, async () => true);
    expect(result).toContain("Linked to");
    const submitted = api.calls.find((c) => c.body)!.body as { host: string; signature: Hex };
    expect(await recoverMessageAddress({ message: good.message, signature: submitted.signature })).toBe(HOST.address);
  });
});

describe("collect earnings", () => {
  it("resumes an unconfirmed team transfer with the same bytes and never withdraws twice", async () => {
    const { ctx, state } = context();
    withdrawal(state);
    state.mine = false;
    await expect(collectEarnings(ctx, "hbar", async () => true)).rejects.toThrow("confirmation is pending");
    const pending = loadConfig().pendingCollection!;
    expect(pending).toMatchObject({ asset: "hbar", withdrawTx: WITHDRAW_TX, withdrawnWei: String(9n * 10n ** 17n) });
    const transfer = parseTransaction(pending.transfer!.raw);
    expect(transfer).toMatchObject({ chainId: 296, to: TEAM, value: 9n * 10n ** 17n, gas: TRANSFER_GAS });

    state.mine = true;
    const confirm = vi.fn(async () => true);
    const done = await collectEarnings(ctx, "hbar", confirm);
    expect(done).toContain("Collected 0.9 HBAR into Acme");
    expect(confirm).not.toHaveBeenCalled();
    expect(withdraw.submit).toHaveBeenCalledTimes(1);
    expect(new Set(state.sent)).toEqual(new Set([pending.transfer!.raw]));
    expect(collections()).toEqual([{ asset: "hbar", withdrawTx: WITHDRAW_TX }, { asset: "hbar", withdrawTx: WITHDRAW_TX, transferTx: pending.transfer!.hash }]);
    expect(loadConfig().pendingCollection).toBeUndefined();
  });

  it("keeps a gas reserve on the host and the withdrawal when the transfer reverts", async () => {
    const { ctx, state } = context();
    withdrawal(state);
    state.balance = HBAR;
    state.revert = true;
    await expect(collectEarnings(ctx, "hbar", async () => true)).rejects.toThrow("the withdrawal is kept");
    const kept = loadConfig().pendingCollection!;
    expect(kept.withdrawTx).toBe(WITHDRAW_TX);
    expect(kept.transfer).toBeUndefined();
    expect(parseTransaction(state.sent[0]).value).toBe(HBAR - TRANSFER_GAS * GAS_PRICE - HOST_GAS_RESERVE_WEI);

    state.revert = false;
    state.balance = HOST_GAS_RESERVE_WEI;
    await expect(collectEarnings(ctx, "hbar", async () => true)).rejects.toThrow("keeps 0.5 HBAR");
    state.balance = 3n * HBAR;
    expect(await collectEarnings(ctx, "hbar", async () => true)).toContain("Collected 0.9 HBAR");
    expect(withdraw.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses to finish a collection to a different team wallet", async () => {
    const { ctx, state } = context();
    withdrawal(state);
    state.mine = false;
    await expect(collectEarnings(ctx, "hbar", async () => true)).rejects.toThrow("pending");
    api.responses.set(`/api/hosts/${HOST.address}/team-link`, { ...link, destination: `0x${"f0".repeat(20)}` });
    await expect(collectEarnings(ctx, "hbar", async () => true)).rejects.toThrow("Relink to the original team");
  });

  it("sends test USDC through the token facade only when the team wallet can hold it", async () => {
    const { ctx, state } = context();
    const missing = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(collectEarnings(ctx, "usdc", async () => true, () => {}, { fetcher: missing as typeof fetch })).rejects.toThrow("cannot hold test USDC");
    expect(state.sent).toHaveLength(0);

    const open = vi.fn(async (url: string) => (String(url).includes("/tokens") ? Response.json({ tokens: [] }) : Response.json({ max_automatic_token_associations: -1 })));
    expect(await acceptsTestUsdc(TEAM, open as typeof fetch)).toBe(true);
    const done = await collectEarnings(ctx, "usdc", async () => true, () => {}, { fetcher: open as typeof fetch });
    expect(done).toContain("Collected 0.005 test USDC into Acme");
    const tx = parseTransaction(state.sent[0]);
    expect(tx.to?.toLowerCase()).toBe(TEST_USDC.toLowerCase());
    expect(decodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), data: tx.data! }).args).toEqual([expect.stringMatching(new RegExp(TEAM, "i")), 5_000n]);
    expect(collections()).toEqual([{ asset: "usdc", transferTx: keccak256(state.sent[0]) }]);
  });
});
