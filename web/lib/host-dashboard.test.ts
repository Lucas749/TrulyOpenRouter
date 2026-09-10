import { expect, it, vi } from "vitest";
import { hbarLabel, heartbeatMs, hostAddresses, loadHostDashboard, totalHostAmount } from "./host-dashboard";

const a = `0x${"a".repeat(40)}`;
const b = `0x${"b".repeat(40)}`;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it("keeps a missing registration visible without breaking another host", async () => {
  const fetchFn = vi.fn(async (url) => String(url).includes("/owners/") ? response({ data: [a, b] })
    : String(url).endsWith(a) ? response({ error: { message: "unknown host" } }, 404)
    : response({ address: b, modelId: "qwen2.5:0.5b", active: true, stake: "400000000", earningsWei: "0" }));
  const data = await loadHostDashboard("owner", [], undefined, fetchFn);
  expect(data.entries.map((e) => e.status)).toEqual(["pending", "ready"]);
  expect(data.entries[0].address).toBe(a);
  expect(totalHostAmount(data.entries, "earningsWei")).toBeNull();
});

it("handles invalid payloads and unavailable account lookups without inventing zero balances", async () => {
  const fetchFn = vi.fn(async (url) => String(url).includes("/owners/") ? response({}, 503) : response({ error: "bad response" }));
  const data = await loadHostDashboard("owner", [a], undefined, fetchFn);
  expect(data.notice).toContain("saved hosts");
  expect(data.entries[0].status).toBe("error");
  expect(totalHostAmount(data.entries, "earningsWei")).toBeNull();
});

it("filters damaged storage and deduplicates addresses regardless of case", () => {
  expect(hostAddresses([null, 12, {}, "invalid", a, a.toUpperCase().replace("0X", "0x")])).toEqual([a]);
});

it("formats tinybar amounts exactly and rejects malformed amounts", () => {
  expect(hbarLabel("400000000")).toBe("4");
  expect(hbarLabel("1")).toBe("0.00000001");
  expect(hbarLabel("0")).toBe("0");
  expect(hbarLabel("broken")).toBe("—");
  expect(hbarLabel(null)).toBe("—");
});

it("accepts both registry seconds and bootstrap milliseconds", () => {
  expect(heartbeatMs(1789071123)).toBe(1789071123000);
  expect(heartbeatMs(1789071123000)).toBe(1789071123000);
  expect(heartbeatMs(Infinity)).toBeNull();
});
