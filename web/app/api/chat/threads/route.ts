import { NextResponse } from "next/server";
import { listThreads, saveThreads } from "../../../../lib/chat-threads";

// Chat history for logged-in users. Identity = client-claimed wallet address:
// fine for reading your OWN threads, never used for authorization.
// GET ?user=0x… -> { threads }; POST { user, threads } -> { ok: true }.
export async function GET(req: Request): Promise<Response> {
  try {
    const user = new URL(req.url).searchParams.get("user") ?? "";
    return NextResponse.json({ threads: await listThreads(user) });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { user?: string; threads?: unknown[] };
    if (!body.user || !Array.isArray(body.threads)) {
      return NextResponse.json({ error: "user + threads[] required" }, { status: 400 });
    }
    if (body.threads.length > 30) return NextResponse.json({ error: "max 30 threads" }, { status: 400 });
    const clean = body.threads.slice(0, 30).map((t: any) => ({
      id: String(t.id ?? "").slice(0, 64),
      title: String(t.title ?? "New chat").slice(0, 80),
      updatedAt: Number(t.updatedAt) || Date.now(),
      msgs: Array.isArray(t.msgs)
        ? t.msgs.slice(0, 200).map((m: any) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: String(m.content ?? "").slice(0, 20000),
            receipt: typeof m.receipt === "string" ? m.receipt.slice(0, 128) : undefined,
            settled: typeof m.settled === "boolean" ? m.settled : undefined,
            ts: Number(m.ts) || Date.now(),
          }))
        : [],
    }));
    await saveThreads(body.user, clean);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 502 });
  }
}
