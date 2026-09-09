import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../src/config.js";
import { ensureHostKey, shouldRegister } from "../src/run.js";

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
