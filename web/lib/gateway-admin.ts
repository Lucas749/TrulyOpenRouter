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
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured, refusing unwatched sync");
  const res = await fetch(`${base()}/api/admin/caps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({ prefix, cap, ...(periodStart === undefined ? {} : { periodStart }) }),
  });
  if (!res.ok) throw new Error(`gateway sync failed: ${(await res.text()).slice(0, 160)}`);
}

/// @notice Mirror one member's effective allowance into the vault's onchain
/// SpendCap (wallet address and/or key prefix — the gateway derives the budget
/// account itself, the web never sees BUDGET_MASTER).
/// Returns "skipped" when the gateway has no chain writer (dev / pre-SpendCap
/// vault): callers MUST continue, gateway pre-flight caps still enforce.
/// Chain txs are slow and external, so unlike syncCap this never throws for
/// transport/chain failures either — it returns "failed" and logs, and the
/// route reports chainSynced:false. Rationale: blocking team admin on chain
/// infra (or an old vault deployment) is worse than a delayed mirror; the
/// gateway gate is the primary enforcer, the chain is the backstop.
export async function syncSpendCap(o: {
  address?: string | null;
  prefix?: string | null;
  capCredits: number | null;
  periodDays?: number;
}): Promise<"synced" | "skipped" | "failed"> {
  if (!o.address && !o.prefix) return "skipped";
  const t = token();
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured, refusing unwatched sync");
  let res: Response;
  try {
    res = await fetch(`${base()}/api/admin/spend-caps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({
        ...(o.address ? { address: o.address } : {}),
        ...(o.prefix ? { prefix: o.prefix } : {}),
        capCredits: o.capCredits,
        periodDays: o.periodDays ?? 30,
      }),
    });
  } catch (e: any) {
    console.error(`spend-cap mirror failed (transport): ${String(e?.message ?? e).slice(0, 160)}`);
    return "failed";
  }
  if (res.status === 501) return "skipped"; // no chain writer: dev / old vault
  if (!res.ok) {
    console.error(`spend-cap mirror failed: ${(await res.text()).slice(0, 160)}`);
    return "failed";
  }
  return "synced";
}

export async function clearCap(prefix: string): Promise<void> {
  const t = token();
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured, refusing unwatched sync");
  const res = await fetch(`${base()}/api/admin/caps/${encodeURIComponent(prefix)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`gateway clear failed: ${(await res.text()).slice(0, 160)}`);
}

export interface OrgRuleSync {
  dailyCapCredits: number | null;
  allowedModels: string[] | null;
  allowedRegions: string[] | null;
  requireVerified: boolean;
  rateLimitPerMin: number | null;
  pinnedHosts: string[] | null;
  handles: string[];
}

/// @notice Push org rules to gateway pre-flight enforcement. Same trust shape
/// as caps: caller holds the wallet signature, this hop is token-authed.
export async function syncOrgRules(orgId: string, rules: OrgRuleSync): Promise<void> {
  const t = token();
  if (!t) throw new Error("GATEWAY_ADMIN_TOKEN not configured, refusing unwatched sync");
  const res = await fetch(`${base()}/api/admin/org-rules`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
    body: JSON.stringify({ orgId, ...rules }),
  });
  if (!res.ok) throw new Error(`gateway org-rules sync failed: ${(await res.text()).slice(0, 160)}`);
}
