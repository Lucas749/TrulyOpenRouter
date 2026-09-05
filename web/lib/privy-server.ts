// Server-side Privy REST client. App secret lives here ONLY (never NEXT_PUBLIC, never client).
import { generateKeyPairSync } from "crypto";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const SECRET = process.env.PRIVY_APP_SECRET ?? "";

function headers(): Record<string, string> {
  return {
    "privy-app-id": APP_ID,
    Authorization: "Basic " + Buffer.from(`${APP_ID}:${SECRET}`).toString("base64"),
    "Content-Type": "application/json",
  };
}

export async function privyApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!APP_ID || !SECRET) throw new Error("Privy server creds not configured");
  const res = await fetch(`https://api.privy.io/v1${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`privy ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

/// @notice Fresh P-256 authorization key (base64 DER) for quorum membership.
export function newAuthKey(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

/// @notice Fresh keypair: public goes to Privy, private stays server-side (quorum-keys store).
/// Format matches privy-sign.ts (`wallet-auth:<base64 PKCS8>`).
export function newAuthKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: "wallet-auth:" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}
