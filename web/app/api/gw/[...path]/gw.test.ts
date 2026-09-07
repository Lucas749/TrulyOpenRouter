import { describe, expect, it } from "vitest";
import { GET as gwGet, POST as gwPost } from "./route";

// Same-origin proxy: browser calls /api/gw/*, server forwards to GATEWAY_URL.
// Proves method/header/body forwarding + streaming passthrough + 502 mapping.
function stubUpstream(handler: (req: Request) => Response | Promise<Response>) {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init: any) => {
    if (String(url).startsWith("http://gw.test")) return handler(new Request(url, init));
    return orig(url, init);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

describe("gateway proxy", () => {
  it("forwards method, auth, body and streams SSE through", async () => {
    process.env.GATEWAY_URL = "http://gw.test";
    const restore = stubUpstream(
      (req) =>
        new Response(`event: hi\ndata: {"auth":"${req.headers.get("authorization")}"}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    try {
      const r = await gwPost(
        new Request("http://x/api/gw/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer k", Accept: "text/event-stream" },
          body: JSON.stringify({ model: "m", stream: true }),
        }),
        { params: Promise.resolve({ path: ["v1", "chat", "completions"] }) },
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/event-stream");
      const text = await r.text();
      expect(text).toContain("event: hi");
      expect(text).toContain("Bearer k");
    } finally {
      restore();
      delete process.env.GATEWAY_URL;
    }
  });

  it("maps gateway-down to 502, never leaks internals", async () => {
    process.env.GATEWAY_URL = "http://127.0.0.1:1";
    try {
      const r = await gwGet(new Request("http://x/api/gw/health"), { params: Promise.resolve({ path: ["health"] }) });
      expect(r.status).toBe(502);
      expect(((await r.json()) as any).error.type).toBe("upstream_error");
    } finally {
      delete process.env.GATEWAY_URL;
    }
  });
});
