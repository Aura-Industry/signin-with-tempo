"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createConfig, createStorage, http, WagmiProvider } from "wagmi";
import { KeyManager, webAuthn } from "wagmi/tempo";
import {
  APP_NAME,
  KEY_MANAGER_PREFIX,
  STORAGE_PREFIX,
  TEMPO_CHAIN,
  TEMPO_RPC_URL,
  TEMPO_RP_ID,
} from "../lib/tempo";

const demoStorage = createStorage({
  key: STORAGE_PREFIX,
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});

const wagmiConfig = createConfig({
  chains: [TEMPO_CHAIN],
  connectors: [
    webAuthn({
      keyManager: KeyManager.localStorage({
        key: KEY_MANAGER_PREFIX,
      }),
      createOptions: {
        label: APP_NAME,
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          requireResidentKey: true,
          residentKey: "required",
          userVerification: "required",
        },
      } as NonNullable<Parameters<typeof webAuthn>[0]["createOptions"]>,
      rpId: TEMPO_RP_ID,
    }),
  ],
  ssr: true,
  storage: demoStorage,
  transports: {
    [TEMPO_CHAIN.id]: http(TEMPO_RPC_URL),
  },
});

export function TempoProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
