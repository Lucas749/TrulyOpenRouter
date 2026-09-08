import { describe, expect, it } from "vitest";
import { cachedGeo, geoForEndpoint, ipOfEndpoint } from "../src/geo.js";

const mem = () => {
  const geos = new Map<string, string>();
  return {
    async geoOf(a: string) {
      return geos.get(a.toLowerCase()) ?? null;
    },
    async setGeo(a: string, g: string) {
      geos.set(a.toLowerCase(), g);
    },
  };
};

describe("geo", () => {
  it("parses literals, skips private exits", () => {
    expect(ipOfEndpoint("http://1.2.3.4:4122")).toBe("1.2.3.4");
    expect(ipOfEndpoint("http://192.168.1.10:11434")).toBe("192.168.1.10");
    expect(ipOfEndpoint("not a url")).toBeNull();
  });

  it("resolves public IPs via ip-api, skips private ones", async () => {
    const fetchFn: any = async (url: string) => {
      expect(url).toContain("http://ip-api.com/json/1.2.3.4");
      return { json: async () => ({ status: "success", countryCode: "US", regionName: "Oregon" }) };
    };
    expect(await geoForEndpoint("http://1.2.3.4:4122", { fetchFn })).toBe("us-oregon");
    expect(await geoForEndpoint("http://192.168.1.10:11434", { fetchFn })).toBeNull();
    expect(await geoForEndpoint("http://localhost:4122", { fetchFn })).toBeNull();
  });

  it("resolves DNS names, tolerates failure", async () => {
    const lookup = async (h: string) => {
      expect(h).toBe("example.com");
      return "93.184.216.34";
    };
    const fetchFn: any = async () => ({ json: async () => ({ status: "success", countryCode: "US", regionName: "California" }) });
    expect(await geoForEndpoint("https://example.com:443", { lookup, fetchFn })).toBe("us-california");
    expect(await geoForEndpoint("https://nope.invalid", { lookup: async () => { throw new Error("nx"); }, fetchFn })).toBeNull();
  });

  it("caches per host (one lookup, then stored)", async () => {
    const store = mem();
    let calls = 0;
    const fetchFn: any = async () => {
      calls++;
      return { json: async () => ({ status: "success", countryCode: "DE", regionName: "Berlin" }) };
    };
    expect(await cachedGeo("0xABC", "http://1.2.3.4:1", store, { fetchFn })).toBe("de-berlin");
    expect(await cachedGeo("0xabc", "http://1.2.3.4:1", store, { fetchFn })).toBe("de-berlin");
    expect(calls).toBe(1);
  });
});
