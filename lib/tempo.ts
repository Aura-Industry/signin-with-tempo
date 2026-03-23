import type { Address } from "viem";
import { tempoModerato } from "viem/chains";
import { Addresses } from "viem/tempo";

export const APP_NAME = "Sign In With Tempo";
export const STORAGE_PREFIX = "sign-in-with-tempo";
export const KEY_MANAGER_PREFIX = `${STORAGE_PREFIX}.keys`;
export const TEMPO_CHAIN = {
  ...tempoModerato,
  feeToken: Addresses.pathUsd as Address,
} as typeof tempoModerato & { feeToken: Address };

export const TEMPO_RPC_URL =
  process.env.NEXT_PUBLIC_TEMPO_RPC_URL || TEMPO_CHAIN.rpcUrls.default.http[0];

export const TEMPO_RP_ID =
  process.env.NEXT_PUBLIC_TEMPO_RP_ID || undefined;

export const TEMPO_EXPLORER_URL =
  TEMPO_CHAIN.blockExplorers?.default.url || "https://explore.tempo.xyz";

export const PATH_USD_ADDRESS = Addresses.pathUsd as Address;
export const PATH_USD_DECIMALS = 6;
