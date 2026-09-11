import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../lib/faucet-auth", () => ({ faucetUser: vi.fn() }));
import { faucetUser } from "../../../../lib/faucet-auth";
import { POST } from "./route";

describe("host funding web route", () => {
  const address = `0x${"12".repeat(20)}`;
  const request = (body: unknown = { address }) => new Request("https://example.test/api/account/host-faucet", { method: "POST", body: JSON.stringify(body) });
  beforeEach(() => {
    vi.stubEnv("GATEWAY_ADMIN_TOKEN", "server-secret");
    vi.stubEnv("GATEWAY_URL", "http://gateway");
    vi.mocked(faucetUser).mockResolvedValue("did:privy:verified");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "pending", amountHbar: 5, transactionId: "tx" }, { status: 202 })));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
  it("rejects an unauthenticated user before contacting the money service", async () => {
    vi.mocked(faucetUser).mockResolvedValue(null);
    expect((await POST(request())).status).toBe(401);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(0);
  });
  it("derives identity from the token and discards client amounts and identity", async () => {
    const response = await POST(request({ address, userId: "did:privy:forged", amount: 50000 }));
    expect(response.status).toBe(202);
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("http://gateway/api/admin/host-faucet");
    expect(JSON.parse(options!.body as string)).toEqual({ address, userId: "did:privy:verified" });
    expect(options!.headers).toMatchObject({ Authorization: "Bearer server-secret" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects malformed recipients and preserves refill errors", async () => {
    expect((await POST(request({ address: "wrong" }))).status).toBe(400);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: "Pool needs a refill." } }, { status: 503 }));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { message: "Pool needs a refill." } });
  });
  it("does not expose infrastructure details on a failed request", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("server-secret at private-host"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("server-secret");
  });
});
