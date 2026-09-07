// Server-to-gateway propagation for spend caps.
// Trust boundary: the CALLER must already hold a wallet signature authorizing the
// change (verified in the route via members.ts). This hop is authed by shared env
// token only (GATEWAY_ADMIN_TOKEN, localhost in dev). Failures are loud (throw) —
// the route must not persist state the gateway will not enforce.

function base(): string {
  return process.env.GATEWAY_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://127.0.0.1:4021";
}

function token(): string {
  return process.env.GATEWAY_ADMIN_TOKEN ?? "";
}

export async function syncCap(prefix: string, cap: number, periodStart?: number): Promise<void> {
  const t = token();
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured — refusing unwatched sync");
  const res = await fetch(`${base()}/api/admin/caps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({ prefix, cap, ...(periodStart === undefined ? {} : { periodStart }) }),
  });
  if (!res.ok) throw new Error(`gateway sync failed: ${(await res.text()).slice(0, 160)}`);
}

export async function clearCap(prefix: string): Promise<void> {
  const t = token();
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured — refusing unwatched sync");
  const res = await fetch(`${base()}/api/admin/caps/${encodeURIComponent(prefix)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`gateway clear failed: ${(await res.text()).slice(0, 160)}`);
}
