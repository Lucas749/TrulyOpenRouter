import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import { PrivateKey } from "@hiero-ledger/sdk";

export interface PayerOptions {
  accountId: string;
  privateKey: string; // hex ECDSA, testnet only in this repo
  network?: "hedera:testnet";
}

/// @notice Paid fetch: 402 → sign Hedera TransferTransaction → retry → settled.
/// Keys live in env (dev) or Key Ring (hosts/prod) — never in code or logs.
export function createPaidFetch(opts: PayerOptions): typeof fetch {
  const network = opts.network ?? "hedera:testnet";
  const signer = createClientHederaSigner(
    opts.accountId,
    PrivateKey.fromStringECDSA(opts.privateKey),
    { network },
  );
  const client = new x402Client().register(network, new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}
