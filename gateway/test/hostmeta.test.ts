import { describe, expect, it } from "vitest";
import { MemoryHostMeta, validRegion } from "../src/hostmeta.js";

describe("hostmeta", () => {
  it("validates slugs, stores case-insensitively, counts distinct", () => {
    expect(validRegion("eu-central")).toBe(true);
    expect(validRegion("EU")).toBe(false);
    expect(validRegion("a")).toBe(false);
    expect(validRegion("no spaces")).toBe(false);
    const m = new MemoryHostMeta();
    expect(m.regionOf("0xABC")).toBeNull();
    m.setRegion("0xABC", "eu-central");
    m.setRegion("0xabc", "eu-west");
    m.setRegion("0xDEF", "eu-central");
    expect(m.regionOf("0xAbC")).toBe("eu-west");
    expect(m.distinctRegions()).toEqual(["eu-west", "eu-central"]);
  });

  it("maps hosts to owners", () => {
    const m = new MemoryHostMeta();
    expect(m.ownerOf("0xabc")).toBeNull();
    expect(m.hostsOf("u1")).toEqual([]);
    m.setOwner("0xABC", "u1");
    m.setOwner("0xdef", "u1");
    m.setOwner("0x123", "u2");
    expect(m.ownerOf("0xabc")).toBe("u1");
    expect(m.hostsOf("u1")).toEqual(["0xabc", "0xdef"]);
  });
});
