/// @notice Human errors for wallet tx failures. RPC/version errors dump JSON
/// (method, params, raw tx) — users need the one actionable sentence instead.
export function friendlyTxError(e: unknown): string {
  const m = String((e as any)?.message ?? e);
  if (/user rejected|user denied|rejected the request|denied/i.test(m)) {
    return "rejected in wallet — retry when ready";
  }
  if (/insufficient|exceeds.*balance|not enough|would exceed|intrinsic/i.test(m)) {
    return "not enough testnet HBAR — fund first (drip + faucet above), then retry";
  }
  if (/Transaction creation failed/i.test(m)) {
    // hashio wrapper text; the cause almost always precedes it or is funds.
    const head = m.split(/Request body|\{/)[0].replace(/Transaction creation failed\.?\s*/i, "").trim();
    return head ? `wallet could not send: ${head.slice(0, 100)}` : "wallet could not send — check funds and retry";
  }
  const head = m.split("\n")[0];
  return head.length > 140 ? `${head.slice(0, 140)}…` : head;
}
