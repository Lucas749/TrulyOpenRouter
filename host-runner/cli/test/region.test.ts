import { describe, expect, it } from "vitest";
import { egressRegion } from "../src/run.js";

const okFetch = (async () => ({
  json: async () => ({ status: "success", countryCode: "DE", regionName: "Hesse" }),
})) as unknown as typeof fetch;

describe("egressRegion (host-side auto-geo)", () => {
  it("formats cc-region slugs like the gateway observed geo", async () => {
    expect(await egressRegion(okFetch)).toBe("de-hesse");
  });

  it("returns null when the lookup fails (offline, rate-limited)", async () => {
    const fail = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await egressRegion(fail)).toBeNull();
    const bad = (async () => ({ json: async () => ({ status: "fail" }) })) as unknown as typeof fetch;
    expect(await egressRegion(bad)).toBeNull();
  });
});
