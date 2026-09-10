import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config.js";
import { DEFAULT_STAKE_HBAR, ensureHostKey, shouldRegister, stakeShortfall } from "../src/run.js";

describe("shouldRegister (idempotent re-runs)", () => {
  it("registers fresh keys", () => {
    expect(shouldRegister(null)).toBe(true);
  });

  it("skips active hosts (no double stake)", () => {
    expect(shouldRegister({ active: true, stake: 10n * 10n ** 18n })).toBe(false);
  });

  it("re-registers inactive records (deregistered/expired)", () => {
    expect(shouldRegister({ active: false, stake: 0n })).toBe(true);
  });
});

describe("stake default (live registry minimum)", () => {
  it("defaults to 10 HBAR plus gas reserve", () => {
    expect(DEFAULT_STAKE_HBAR).toBe(10);
    expect(stakeShortfall(0n, DEFAULT_STAKE_HBAR)).toBe(11n * 10n ** 18n);
  });
});

describe("stakeShortfall (stake + gas headroom)", () => {
  const HBAR = 10n ** 18n;
  it("exactly-staked keys are still short (gas has nowhere to come from)", () => {
    expect(stakeShortfall(10n * HBAR, 10)).toBe(1n * HBAR);
  });
  it("zero balance needs stake + headroom", () => {
    expect(stakeShortfall(0n, 10)).toBe(11n * HBAR);
  });
  it("covered balances return zero", () => {
    expect(stakeShortfall(11n * HBAR, 10)).toBe(0n);
    expect(stakeShortfall(100n * HBAR, 10)).toBe(0n);
  });
});

describe("ensureHostKey (login-time binding)", () => {
  const prev = process.env.TOR_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.TOR_HOME;
    else process.env.TOR_HOME = prev;
  });

  it("generates once, then returns the same address with hostAddress saved", () => {
    process.env.TOR_HOME = mkdtempSync(join(tmpdir(), "tor-key-"));
    const first = ensureHostKey("http://gw:4121");
    expect(first.fresh).toBe(true);
    expect(first.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const second = ensureHostKey("http://gw:4121");
    expect(second.fresh).toBe(false);
    expect(second.address).toBe(first.address);
    // funding pages + retries read the address before any register
    expect(loadConfig().hostAddress).toBe(first.address);
  });
});
