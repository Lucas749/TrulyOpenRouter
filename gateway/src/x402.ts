import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

// x402 needs a facilitator to verify and settle a payment. Testnet goes through Blocky402,
// which settles on Hedera, rather than the x402.org reference. Override with the env var.
const TESTNET_FACILITATOR =
  process.env.X402_TESTNET_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";

export function createResourceServer() {
  const facilitatorClient = new HTTPFacilitatorClient({ url: TESTNET_FACILITATOR });
  return new x402ResourceServer(facilitatorClient).register("hedera:*", new ExactHederaScheme({}));
}

export function facilitatorUrl(): string {
  return TESTNET_FACILITATOR;
}
