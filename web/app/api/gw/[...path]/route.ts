import { NextResponse } from "next/server";

// Same-origin gateway proxy. Browser pages must NEVER fetch the gateway
// directly: its address is localhost in dev and plain-http on the box, so
// direct browser calls trigger local-network permission prompts and mixed-
// content blocks on the hosted (https) site. Everything goes through here;
// the server side reaches the gateway over GATEWAY_URL (server-to-server,
// no browser involved). Auth headers pass through untouched.

function target(path: string[], search: string): string | null {
  const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:4121";
  return `${base.replace(/\/+$/, "")}/${path.map(encodeURIComponent).join("/")}${search}`;
}

async function proxy(req: Request, path: string[]): Promise<Response> {
  const url = target(path, new URL(req.url).search);
  if (!url) return NextResponse.json({ error: "gateway not configured" }, { status: 501 });
  const headers: Record<string, string> = {};
  const auth = req.headers.get("authorization");
  if (auth) headers.authorization = auth;
  const ct = req.headers.get("content-type");
  if (ct) headers["content-type"] = ct;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer(),
    });
    // Stream through (SSE chat included) — never buffer.
    const resHeaders: Record<string, string> = {};
    const resCt = upstream.headers.get("content-type");
    if (resCt) resHeaders["content-type"] = resCt;
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  } catch (e: any) {
    return NextResponse.json({ error: { message: `gateway unreachable: ${String(e?.message ?? e).slice(0, 120)}`, type: "upstream_error" } }, { status: 502 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(req, (await params).path);
}
export async function POST(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(req, (await params).path);
}
export async function PUT(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(req, (await params).path);
}
export async function PATCH(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(req, (await params).path);
}
export async function DELETE(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return proxy(req, (await params).path);
}
