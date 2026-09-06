import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/node";
import { privyApi } from "./privy-server";
import { getQuorumKey } from "./quorum-keys";

// Privy async approvals for team wallets: propose -> collect signatures -> auto-execute.
// Authorize payload shape reverse-engineered from the Java SDK sources
// (io.privy:api:privy-java, IntentAuthorizeSignatureInput): standard envelope PLUS
// top-level `timestamp` + `intent_id`, with the SAME timestamp submitted in the body.
// Verified live: 200 + signed_at set (see git history for the 18-variant hunt).

export interface IntentSummary {
  intent_id: string;
  status: string;
  intent_type?: string;
  authorization_details?: unknown;
  action_result?: unknown;
  expires_at?: number;
}

/// @notice The exact bytes the authorize signature is over: action envelope +
/// `timestamp` + `intent_id`, timestamp shared with the submitted body.
export function authorizePayload(
  intent: { request_details: { method: string; url: string; body: unknown } },
  appId: string,
  intentId: string,
  timestamp: number,
): {
  version: 1;
  method: "POST";
  url: string;
  body: unknown;
  headers: { "privy-app-id": string };
  timestamp: number;
  intent_id: string;
} {
  return {
    version: 1,
    method: intent.request_details.method as "POST",
    url: intent.request_details.url,
    body: intent.request_details.body,
    headers: { "privy-app-id": appId },
    timestamp,
    intent_id: intentId,
  };
}

export async function proposeSignIntent(
  walletId: string,
  tx: { to: string; value: string; chainId: number; data?: string },
): Promise<IntentSummary> {
  return privyApi("POST", `/intents/wallets/${walletId}/rpc`, {
    method: "eth_signTransaction",
    params: { transaction: { to: tx.to, value: tx.value, chain_id: tx.chainId, ...(tx.data ? { data: tx.data } : {}) } },
  });
}

export async function getIntent(intentId: string): Promise<IntentSummary> {
  return privyApi("GET", `/intents/${intentId}`);
}

export async function authorizeIntent(intentId: string, quorumId: string): Promise<IntentSummary> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
  const privateKey = getQuorumKey(quorumId);
  if (!privateKey) throw new Error(`no server-held key for quorum ${quorumId} (pre-store team or recreate)`);
  const intent: any = await getIntent(intentId);
  if (!intent?.request_details) throw new Error("intent has no request_details");
  const timestamp = Date.now();
  const formatted = formatRequestForAuthorizationSignature(authorizePayload(intent, appId, intentId, timestamp));
  const signature = generateAuthorizationSignature({
    authorizationPrivateKey: privateKey.replace(/^wallet-auth:/, ""),
    input: formatted,
  });
  return privyApi("POST", `/intents/${intentId}/authorize`, { signature, timestamp });
}
