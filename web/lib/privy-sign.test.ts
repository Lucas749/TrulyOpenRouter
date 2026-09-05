import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "crypto";
import {
  authorizationSignature,
  signaturePayload,
  verifyAuthorizationSignature,
} from "../lib/privy-sign";

function freshKeypair(): { priv: string; pub: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    priv: "wallet-auth:" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pub: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const input = {
  method: "POST" as const,
  url: "https://api.privy.io/v1/intents/abc/authorize",
  body: { hello: "world", n: 1 },
  appId: "test-app",
};

describe("privy-sign", () => {
  it("canonicalizes deterministically regardless of key order", () => {
    const a = signaturePayload({ ...input, body: { b: 1, a: 2 } });
    const b = signaturePayload({ ...input, body: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a).toContain('"version":1');
  });

  it("signs and verifies a full roundtrip", () => {
    const { priv, pub } = freshKeypair();
    const sig = authorizationSignature(input, priv);
    expect(verifyAuthorizationSignature(input, sig, pub)).toBe(true);
  });

  it("rejects tampered bodies and wrong keys", () => {
    const { priv, pub } = freshKeypair();
    const { pub: other } = freshKeypair();
    const sig = authorizationSignature(input, priv);
    expect(verifyAuthorizationSignature({ ...input, body: { hello: "mallory" } }, sig, pub)).toBe(false);
    expect(verifyAuthorizationSignature(input, sig, other)).toBe(false);
  });
});
