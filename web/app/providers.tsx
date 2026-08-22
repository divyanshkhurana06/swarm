"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { chain } from "@/lib/contracts";

/**
 * Google sign-in with an auto-created embedded wallet.
 *
 * A worker signs in with an account they already have; Privy creates an EVM
 * wallet for them behind the scenes. They never see a seed phrase, never
 * install anything, and never learn the word "wallet" -- which is the same
 * promise the passkey flow made, with an onboarding step people have done a
 * thousand times before.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

  // Without an app id Privy throws on mount and takes the whole page with it.
  // Render the app anyway so the dashboard and read-only screens still work.
  if (!appId) return <>{children}</>;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["google"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        defaultChain: chain,
        supportedChains: [chain],
        appearance: {
          theme: "dark",
          accentColor: "#34d399",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
