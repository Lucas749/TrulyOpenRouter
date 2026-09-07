import { describe, expect, it } from "vitest";
import { collectLedgerState, renderLedgerState } from "../src/ledger.js";

const runner = (outs: Record<string, { ok: boolean; out: string }>) => ({
  run: async (args: string[]) => outs[args.join(" ")] ?? { ok: false, out: "unknown command" },
});

describe("ledger status", () => {
  it("reads genuine device + provisioned ring, names only", async () => {
    process.env.WALLET_PASS = "test-only";
    try {
      const s = await collectLedgerState(
        runner({
          "--version": { ok: true, out: '{"ok":true,"data":{"version":"2.1.0"}}' },
          "genuine-check": { ok: true, out: "Device is genuine" },
          "ring keys": { ok: true, out: "Key       First Used\n────────────────────\ntor/demo  2026-09-07\ntor/host  2026-09-07" },
        }),
      );
      expect(s).toMatchObject({ device: "genuine", ring: "provisioned", passwordEnv: true, cli: "v2.1.0" });
      expect(s.keys).toEqual(["tor/demo", "tor/host"]);
      const lines = renderLedgerState(s).join("\n");
      expect(lines).toContain("genuine ✓");
      expect(lines).toContain("tor/host");
    } finally {
      delete process.env.WALLET_PASS;
    }
  });

  it("reports absent ring and missing password without touching secrets", async () => {
    delete process.env.WALLET_PASS;
    const s = await collectLedgerState(
      runner({
        "--version": { ok: true, out: '{"ok":true,"data":{"version":"2.1.0"}}' },
        "genuine-check": { ok: false, out: "[✖] Wrong app. Open Ledger dashboard." },
      }),
    );
    expect(s).toMatchObject({ device: "wrong-app", ring: "unknown", passwordEnv: false });
    expect(renderLedgerState(s).join("\n")).toContain("dashboard");
  });

  it("handles missing cli", async () => {
    const s = await collectLedgerState(runner({}));
    expect(s.cli).toContain("npm i -g");
    expect(s.device).toBe("locked-or-absent");
  });
});
