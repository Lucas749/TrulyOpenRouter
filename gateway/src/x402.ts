import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

// Qual REQUIRES Blocky402 settlement: default testnet to Blocky, NOT x402.org (see SPEC §8a).
const TESTNET_FACILITATOR =
  process.env.X402_TESTNET_FACILITATOR_URL ?? "https://api.testnet.blocky402.com";

export function createResourceServer() {
  const facilitatorClient = new HTTPFacilitatorClient({ url: TESTNET_FACILITATOR });
  return new x402ResourceServer(facilitatorClient).register("hedera:*", new ExactHederaScheme({}));
}

export function facilitatorUrl(): string {
  return TESTNET_FACILITATOR;
}
