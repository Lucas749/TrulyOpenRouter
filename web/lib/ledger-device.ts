"use client";

// Browser Ledger access through Ledger's Device Management Kit over WebHID.
// Used only after a human clicks: enrollment verifies the Ethereum address on
// the device, and approvals sign the exact gateway-built message (EIP-191) on
// the device. The kit loads on demand so pages without Ledger stay light.

export const LEDGER_PATH = "44'/60'/0'/0/0";

export interface LedgerSession {
  /// @notice The device's Ethereum address, shown on the device for confirmation.
  verifiedAddress(): Promise<string>;
  /// @notice A 65-byte EIP-191 signature over `message`, approved on the device.
  signMessage(message: string): Promise<`0x${string}`>;
  close(): Promise<void>;
}

export class LedgerUnavailableError extends Error {}

export function webHidSupported(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

type ActionState<T> = { status: string; output?: T; error?: unknown; intermediateValue?: { requiredUserInteraction?: string } };
type Action<T> = { observable: { subscribe(o: { next(s: ActionState<T>): void; error(e: unknown): void }): { unsubscribe(): void } }; cancel(): void };

/// @notice Resolve a device action with its completed output, or reject with its error.
function complete<T>(action: Action<T>, onInteraction?: (step: string) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // Emissions can arrive before subscribe() returns, so release on the next tick.
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      finish();
      queueMicrotask(() => subscription.unsubscribe());
    };
    const subscription = action.observable.subscribe({
      next(state) {
        if (state.status === "pending" && state.intermediateValue?.requiredUserInteraction) onInteraction?.(state.intermediateValue.requiredUserInteraction);
        if (state.status === "completed") settle(() => resolve(state.output as T));
        if (state.status === "error" || state.status === "stopped") {
          const reason = state.error as { message?: string; _tag?: string } | undefined;
          settle(() => reject(new Error(reason?.message ?? reason?._tag ?? "The Ledger action did not complete.")));
        }
      },
      error(e) {
        settle(() => reject(e instanceof Error ? e : new Error(String(e))));
      },
    });
    if (settled) subscription.unsubscribe();
  });
}

const hex = (v: string) => v.replace(/^0x/, "").padStart(64, "0");

/// @notice Connect to the first Ledger chosen in the browser's device prompt.
export async function connectLedger(onInteraction?: (step: string) => void): Promise<LedgerSession> {
  if (!webHidSupported()) {
    throw new LedgerUnavailableError("This browser cannot reach a Ledger. Use desktop Chrome, Edge, or Brave; the request stays pending until then.");
  }
  const [{ DeviceManagementKitBuilder }, { webHidTransportFactory, webHidIdentifier }, { SignerEthBuilder }] = await Promise.all([
    import("@ledgerhq/device-management-kit"),
    import("@ledgerhq/device-transport-kit-web-hid"),
    import("@ledgerhq/device-signer-kit-ethereum"),
  ]);
  const dmk = new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build();
  const device = await new Promise<Parameters<typeof dmk.connect>[0]["device"]>((resolve, reject) => {
    const subscription = dmk.startDiscovering({ transport: webHidIdentifier }).subscribe({
      next(found) {
        subscription.unsubscribe();
        resolve(found);
      },
      error(e) {
        reject(new LedgerUnavailableError(`No Ledger selected: ${String((e as Error)?.message ?? e)}`));
      },
    });
  });
  const sessionId = await dmk.connect({ device });
  const signer = new SignerEthBuilder({ dmk, sessionId }).build();
  return {
    async verifiedAddress() {
      const out = await complete<{ address: string }>(signer.getAddress(LEDGER_PATH, { checkOnDevice: true }) as unknown as Action<{ address: string }>, onInteraction);
      return out.address.toLowerCase();
    },
    async signMessage(message: string) {
      const sig = await complete<{ r: string; s: string; v: number }>(signer.signMessage(LEDGER_PATH, message) as unknown as Action<{ r: string; s: string; v: number }>, onInteraction);
      const v = sig.v < 27 ? sig.v + 27 : sig.v;
      return `0x${hex(sig.r)}${hex(sig.s)}${v.toString(16).padStart(2, "0")}`;
    },
    async close() {
      await dmk.disconnect({ sessionId }).catch(() => {});
      dmk.close();
    },
  };
}
