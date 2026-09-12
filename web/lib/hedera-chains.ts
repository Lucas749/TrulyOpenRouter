import { defineChain } from "viem";

// Hedera is NOT a Privy-default chain: configure it explicitly and override the RPC.
// Managed extras (gas sponsorship, swaps) are assumed unavailable here, plain transfers only.
export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  network: "hedera-testnet",
  nativeCurrency: { decimals: 18, name: "HBAR", symbol: "HBAR" },
  rpcUrls: {
    default: { http: ["https://testnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
  testnet: true,
});

export const hederaMainnet = defineChain({
  id: 295,
  name: "Hedera Mainnet",
  network: "hedera-mainnet",
  nativeCurrency: { decimals: 18, name: "HBAR", symbol: "HBAR" },
  rpcUrls: {
    default: { http: ["https://mainnet.hashio.io/api"] },
  },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/mainnet" },
  },
});
