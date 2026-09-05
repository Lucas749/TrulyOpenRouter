import {
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
} from "@privy-io/node";
import { privyApi } from "./privy-server";
import { getQuorumKey } from "./quorum-keys";

// Privy async approvals for team wallets: propose -> collect signatures -> auto-execute.
// ⚠️ AUTHORIZE PAYLOAD PENDING CONFIRMATION — see .local/PRIVY-INTENTS-QUESTION.md.
// `authorizePayload()` is the single place to fix once Privy support answers; propose +
// status + UI are verified live. Do not "fix" by guessing further (10 variants tried).

export interface IntentSummary {
  intent_id: string;
  status: string;
  intent_type?: string;
  authorization_details?: unknown;
  action_result?: unknown;
  expires_at?: number;
}

/// @notice The exact bytes the authorize signature is over. CURRENT BEST GUESS.
export function authorizePayload(intent: { request_details: { method: string; url: string; body: unknown } }, appId: string): {
  version: 1;
  method: "POST";
  url: string;
  body: unknown;
  headers: { "privy-app-id": string };
} {
  return {
    version: 1,
    method: intent.request_details.method as "POST",
    url: intent.request_details.url,
    body: intent.request_details.body,
    headers: { "privy-app-id": appId },
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
  const formatted = formatRequestForAuthorizationSignature(authorizePayload(intent, appId));
  const signature = generateAuthorizationSignature({
    authorizationPrivateKey: privateKey.replace(/^wallet-auth:/, ""),
    input: formatted,
  });
  return privyApi("POST", `/intents/${intentId}/authorize`, { signature, timestamp: Date.now() });
}
