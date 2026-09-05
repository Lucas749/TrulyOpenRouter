import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig, saveConfig, validCode } from "../src/config.js";
import { digestModelfile } from "../src/run.js";

describe("cli config", () => {
  it("validates device codes", () => {
    expect(validCode("abc234")).toBe(true);
    expect(validCode("  k7m2p9 ")).toBe(true);
    expect(validCode("abc12")).toBe(false);
    expect(validCode("abc1234")).toBe(false);
    expect(validCode("abc123")).toBe(false); // 1 excluded (confusable with I)
    expect(validCode("abc!23")).toBe(false);
    expect(validCode("abcO23")).toBe(false); // O excluded (confusable with 0)
  });
});

describe("cli roundtrips", () => {
  it("saves/loads config in TOR_HOME with 0600", () => {
    process.env.TOR_HOME = mkdtempSync(join(tmpdir(), "tor-"));
    saveConfig({ gateway: "http://x:4121", token: "t", userId: "u" });
    expect(loadConfig()).toMatchObject({ gateway: "http://x:4121", userId: "u" });
    expect(String(readFileSync(join(process.env.TOR_HOME, "config.json"))).length).toBeGreaterThan(10);
    delete process.env.TOR_HOME;
  });

  it("digests modelfiles deterministically", () => {
    expect(digestModelfile("FROM x")).toBe(digestModelfile("FROM x"));
    expect(digestModelfile("FROM x")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(digestModelfile("FROM y")).not.toBe(digestModelfile("FROM x"));
  });
});
