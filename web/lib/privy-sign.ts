import canonicalize from "canonicalize";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "crypto";

// Direct Privy authorization signing (docs: controls/authorization-keys direct-implementation).
// Payload: {version:1, method, url, body, headers:{privy-app-id}} -> RFC8785 canonical JSON
// -> ECDSA P-256/SHA-256 -> base64 DER. Private keys in `wallet-auth:<base64 PKCS8>` form.

export interface SignInput {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body: unknown;
  appId: string;
}

export function signaturePayload(input: SignInput): string {
  const payload = {
    version: 1,
    method: input.method,
    url: input.url,
    body: input.body,
    headers: { "privy-app-id": input.appId },
  };
  const out = canonicalize(payload);
  if (!out) throw new Error("canonicalization failed");
  return out;
}

/// @notice privateKey accepts `wallet-auth:`-prefixed or raw base64 PKCS8.
export function authorizationSignature(input: SignInput, privateKey: string): string {
  const b64 = privateKey.replace(/^wallet-auth:/, "");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----`;
  const key = createPrivateKey({ key: pem, format: "pem" });
  return nodeSign("sha256", Buffer.from(signaturePayload(input)), key).toString("base64");
}

export function verifyAuthorizationSignature(
  input: SignInput,
  signatureB64: string,
  publicKeyDerB64: string,
): boolean {
  const pub = createPublicKey({
    key: Buffer.from(publicKeyDerB64, "base64"),
    format: "der",
    type: "spki",
  });
  return nodeVerify(
    "sha256",
    Buffer.from(signaturePayload(input)),
    pub,
    Buffer.from(signatureB64, "base64"),
  );
}
