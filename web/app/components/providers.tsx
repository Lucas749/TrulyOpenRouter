"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { hederaTestnet } from "../../lib/hedera-chains";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? ""}
      config={{
        loginMethods: ["email"],
        appearance: { theme: "light", landingHeader: "TrulyOpenRouter" },
        defaultChain: hederaTestnet,
        supportedChains: [hederaTestnet],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
