import { NextResponse } from "next/server";

// Demo-mode chat. A signed-out explorer has no wallet and no credits, so the call is
// paid by a single demo credential held ONLY here (DEMO_CHAT_KEY). The key never reaches
// the browser, and the gateway enforces that key's own ceilings — daily credits, requests
// per minute, allowed models — which is what bounds abuse. Only the fields a chat needs
// are forwarded: a caller cannot pick the payer, a team, or a handle.

const MAX_MESSAGES = 8;
const MAX_CHARS = 2000;

export async function POST(req: Request): Promise<Response> {
  const key = process.env.DEMO_CHAT_KEY;
  if (!key) {
    return NextResponse.json({ error: { message: "Demo chat is not configured.", type: "unavailable" } }, { status: 501 });
  }
  const base = (process.env.GATEWAY_URL ?? "http://127.0.0.1:4121").replace(/\/+$/, "");

  let body: { model?: unknown; messages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: { message: "invalid JSON", type: "invalid_request" } }, { status: 400 });
  }
  const model = typeof body.model === "string" ? body.model.slice(0, 80) : "";
  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m): m is { role: string; content: string } => !!m && typeof m === "object" && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!model || !messages.length) {
    return NextResponse.json({ error: { message: "model and messages are required", type: "invalid_request" } }, { status: 400 });
  }

  try {
    const upstream = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages }),
    });
    // Stream through, same as the gateway proxy — never buffer.
    const headers: Record<string, string> = {};
    const ct = upstream.headers.get("content-type");
    if (ct) headers["content-type"] = ct;
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (e) {
    return NextResponse.json(
      { error: { message: `gateway unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`, type: "upstream_error" } },
      { status: 502 },
    );
  }
}
