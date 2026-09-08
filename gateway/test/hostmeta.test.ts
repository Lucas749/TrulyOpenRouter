import { describe, expect, it } from "vitest";
import { MemoryHostMeta, validRegion } from "../src/hostmeta.js";

describe("hostmeta", () => {
  it("validates slugs, stores case-insensitively, counts distinct", async () => {
    expect(validRegion("eu-central")).toBe(true);
    expect(validRegion("EU")).toBe(false);
    expect(validRegion("a")).toBe(false);
    expect(validRegion("no spaces")).toBe(false);
    const m = new MemoryHostMeta();
    expect(await m.regionOf("0xABC")).toBeNull();
    await m.setRegion("0xABC", "eu-central");
    await m.setRegion("0xabc", "eu-west");
    await m.setRegion("0xDEF", "eu-central");
    expect(await m.regionOf("0xAbC")).toBe("eu-west");
    expect(await m.distinctRegions()).toEqual(["eu-west", "eu-central"]);
  });

  it("maps hosts to owners", async () => {
    const m = new MemoryHostMeta();
    expect(await m.ownerOf("0xabc")).toBeNull();
    expect(await m.hostsOf("u1")).toEqual([]);
    await m.setOwner("0xABC", "u1");
    await m.setOwner("0xdef", "u1");
    await m.setOwner("0x123", "u2");
    expect(await m.ownerOf("0xabc")).toBe("u1");
    expect(await m.hostsOf("u1")).toEqual(["0xabc", "0xdef"]);
  });
});
