import { randomBytes } from "crypto";

// Device-code login for the host CLI: `tor-host login` shows a code, the user approves it
// on the web (Privy-authenticated), the CLI polls until approved, then stores the token.
// v1: codes are short-lived randoms; approval binds a userId. Production adds rate limits
// + signature-bound tokens (see SPEC).

const CODE_TTL_MS = 10 * 60_000;

export type DeviceStatus = "pending" | "approved" | "expired" | "unknown";

interface DeviceCode {
  code: string;
  userId: string | null;
  token: string | null;
  expiresAt: number;
}

function newCode(existing: Set<string>): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no confusables
  for (;;) {
    let code = "";
    const buf = randomBytes(6);
    for (const b of buf) code += alphabet[b % alphabet.length];
    if (!existing.has(code)) return code;
  }
}

export class MemoryDeviceFlow {
  private codes = new Map<string, DeviceCode>();

  issue(): { code: string; expiresAt: number } {
    this.prune();
    const code = newCode(new Set(this.codes.keys()));
    const rec: DeviceCode = { code, userId: null, token: null, expiresAt: Date.now() + CODE_TTL_MS };
    this.codes.set(code, rec);
    return { code, expiresAt: rec.expiresAt };
  }

  approve(code: string, userId: string): { token: string } | null {
    const rec = this.codes.get(code.toUpperCase());
    if (!rec || rec.expiresAt < Date.now()) return null;
    if (!userId || userId.length > 128) return null;
    rec.userId = userId;
    rec.token = `tor_dev_${randomBytes(18).toString("base64url")}`;
    return { token: rec.token };
  }

  poll(code: string): { status: DeviceStatus; userId?: string; token?: string } {
    const rec = this.codes.get(code.toUpperCase());
    if (!rec) return { status: "unknown" };
    if (rec.expiresAt < Date.now()) {
      this.codes.delete(code.toUpperCase());
      return { status: "expired" };
    }
    if (rec.token && rec.userId) return { status: "approved", userId: rec.userId, token: rec.token };
    return { status: "pending" };
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
  }
}
