// cli/config.ts
// Single source of truth for all contract addresses, RPC URLs,
// and CRE workflow HTTP endpoints.
// Replace placeholder values with your deployed addresses before running.

import { loadCliEnv } from "./env.js"

loadCliEnv()

const infuraKey = process.env.INFURA_API_KEY

export const CHAINS = {
  sepolia: {
    name:          "Ethereum Sepolia",
    chainId:       11155111,
    chainIdHex:    "0xaa36a7",
    selector:      16015286601757825753n,
    rpcUrl:
      process.env.SEPOLIA_RPC_URL ??
      (infuraKey
        ? `https://sepolia.infura.io/v3/${infuraKey}`
        : "https://ethereum-sepolia-rpc.publicnode.com"),
    blockExplorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  amoy: {
    name:          "Polygon Amoy",
    chainId:       80002,
    chainIdHex:    "0x13882",
    selector:      16281711391670634445n,
    rpcUrl:        process.env.AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
    blockExplorer: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  },
  arbitrumSepolia: {
    name:          "Arbitrum Sepolia",
    chainId:       421614,
    chainIdHex:    "0x66eee",
    selector:      3478487238524512106n,
    rpcUrl:        process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc",
    blockExplorer: "https://sepolia.arbiscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  baseSepolia: {
    name:          "Base Sepolia",
    chainId:       84532,
    chainIdHex:    "0x14a34",
    selector:      10344971235874465080n,
    rpcUrl:        process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  fuji: {
    name:          "Avalanche Fuji",
    chainId:       43113,
    chainIdHex:    "0xa869",
    selector:      14767482510784806043n,
    rpcUrl:        process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    blockExplorer: "https://testnet.snowtrace.io",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  },
} as const

export type ChainKey = keyof typeof CHAINS
export type Address = `0x${string}`

export interface TokenPreset {
  symbol: string
  label: string
  address: Address
  decimals: number
}

function isAddressLike(value: string): value is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

function asAddressOrFallback(value: string | undefined, fallback: Address): Address {
  if (!value) return fallback
  return isAddressLike(value) ? (value as Address) : fallback
}

function toSortedUniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isFinite(v) && v > 0))].sort((a, b) => a - b)
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true
  if (v === "0" || v === "false" || v === "no" || v === "off") return false
  return fallback
}

function parseAddressMapEnv(envName: string, fallback: Record<number, Address>): Record<number, Address> {
  const raw = process.env[envName]
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    const out: Record<number, Address> = { ...fallback }
    for (const [key, value] of Object.entries(parsed)) {
      const chainId = Number(key)
      if (!Number.isFinite(chainId)) continue
      if (!isAddressLike(value)) continue
      out[chainId] = value as Address
    }
    return out
  } catch {
    return fallback
  }
}

function parseSourceChains(envName: string, fallback: number[]): number[] {
  const raw = process.env[envName]
  if (!raw) return fallback
  try {
    if (raw.trim().startsWith("[")) {
      return toSortedUniqueNumbers(JSON.parse(raw) as number[])
    }
    return toSortedUniqueNumbers(
      raw
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isFinite(v))
    )
  } catch {
    return fallback
  }
}

function mapChainIds(map: Record<number, Address>, fallback: number[] = [CHAINS.sepolia.chainId]): number[] {
  const ids = toSortedUniqueNumbers(Object.keys(map).map((k) => Number(k)))
  return ids.length > 0 ? ids : fallback
}

function primaryFromMap(
  map: Record<number, Address>,
  preferredChainId: number,
  fallback: Address
): Address {
  return map[preferredChainId] ?? Object.values(map)[0] ?? fallback
}

const DEFAULT_ADDRESSES = {
  automatedTrader: "0xCB8D1Cb78085ca8bce16aa3cFa2f68D7d099270F" as Address,
  automatedTraderReceiver: "0x7E050e0D771dBcf0BcBD6f00b8beAa781667319c" as Address,
  tokenTransferSender: "0x17314cc6E02580b979DFfb48d9e3669773EE5830" as Address,
  tokenTransferReceiver: "0xEB9d02d1bF42408C46670F457999A4c51732f437" as Address,
  chainAlertRegistry: "0x32D02cA7fEd4521233aEbaAD6d36788315D3c088" as Address,
  programmableTokenSender: "0x2ff099d3197F1Dc49ae586ef0d0dC7a8D64FFE77" as Address,
  programmableTokenReceiver: "0x035851C4d61C16ff9EE1f39a484Ba60465977668" as Address,
  chainRegistry: "0xAA8e96df95BeB248e27Ba1170eE0c58C905Ff02B" as Address,
  tokenVerifier: "0x7F2C17f2C421C10e90783f9C2823c6Dd592b9EB4" as Address,
  linkToken: "0x779877A7B0D9E8603169DdbD7836e478b4624789" as Address,
}

export const LINK_TOKEN_BY_CHAIN_ID = parseAddressMapEnv("LINK_TOKEN_BY_CHAIN_ID_JSON", {
  [CHAINS.sepolia.chainId]: asAddressOrFallback(process.env.LINK_TOKEN_ADDRESS, DEFAULT_ADDRESSES.linkToken),
})

export const AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID = parseAddressMapEnv("AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID_JSON", {
  [CHAINS.sepolia.chainId]: asAddressOrFallback(process.env.AUTOMATED_TRADER_ADDRESS, DEFAULT_ADDRESSES.automatedTrader),
})

export const AUTOMATED_TRADER_RECEIVER_BY_DEST_CHAIN_ID = parseAddressMapEnv(
  "AUTOMATED_TRADER_RECEIVER_BY_DEST_CHAIN_ID_JSON",
  {
    [CHAINS.amoy.chainId]: asAddressOrFallback(
      process.env.AUTOMATED_TRADER_RECEIVER_ADDRESS,
      DEFAULT_ADDRESSES.automatedTraderReceiver
    ),
  }
)

export const TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID = parseAddressMapEnv(
  "TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID_JSON",
  {
    [CHAINS.sepolia.chainId]: asAddressOrFallback(
      process.env.TOKEN_TRANSFER_SENDER_ADDRESS ?? process.env.CHAIN_SHIELD_ADDRESS,
      DEFAULT_ADDRESSES.tokenTransferSender
    ),
  }
)

export const TOKEN_TRANSFER_RECEIVER_BY_DEST_CHAIN_ID = parseAddressMapEnv(
  "TOKEN_TRANSFER_RECEIVER_BY_DEST_CHAIN_ID_JSON",
  {
    [CHAINS.amoy.chainId]: asAddressOrFallback(
      process.env.TOKEN_TRANSFER_RECEIVER_ADDRESS,
      DEFAULT_ADDRESSES.tokenTransferReceiver
    ),
  }
)

export const PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID = parseAddressMapEnv(
  "PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID_JSON",
  {
    [CHAINS.sepolia.chainId]: asAddressOrFallback(
      process.env.PROGRAMMABLE_TOKEN_SENDER_ADDRESS,
      DEFAULT_ADDRESSES.programmableTokenSender
    ),
  }
)

export const PROGRAMMABLE_TOKEN_RECEIVER_BY_DEST_CHAIN_ID = parseAddressMapEnv(
  "PROGRAMMABLE_TOKEN_RECEIVER_BY_DEST_CHAIN_ID_JSON",
  {
    [CHAINS.amoy.chainId]: asAddressOrFallback(
      process.env.PROGRAMMABLE_TOKEN_RECEIVER_ADDRESS,
      DEFAULT_ADDRESSES.programmableTokenReceiver
    ),
  }
)

export const CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID = parseAddressMapEnv(
  "CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID_JSON",
  {
    [CHAINS.sepolia.chainId]: asAddressOrFallback(
      process.env.CHAIN_ALERT_REGISTRY_ADDRESS,
      DEFAULT_ADDRESSES.chainAlertRegistry
    ),
  }
)

// ─── Contract addresses (backward compatible primary addresses) ──────────────

export const CONTRACTS = {
  automatedTrader: primaryFromMap(
    AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
    CHAINS.sepolia.chainId,
    DEFAULT_ADDRESSES.automatedTrader
  ),
  automatedTraderReceiver: primaryFromMap(
    AUTOMATED_TRADER_RECEIVER_BY_DEST_CHAIN_ID,
    CHAINS.amoy.chainId,
    DEFAULT_ADDRESSES.automatedTraderReceiver
  ),
  chainShieldTransfer: primaryFromMap(
    TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID,
    CHAINS.sepolia.chainId,
    DEFAULT_ADDRESSES.tokenTransferSender
  ),
  tokenTransferSender: primaryFromMap(
    TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID,
    CHAINS.sepolia.chainId,
    DEFAULT_ADDRESSES.tokenTransferSender
  ),
  tokenTransferReceiver: primaryFromMap(
    TOKEN_TRANSFER_RECEIVER_BY_DEST_CHAIN_ID,
    CHAINS.amoy.chainId,
    DEFAULT_ADDRESSES.tokenTransferReceiver
  ),
  chainAlertRegistry: primaryFromMap(
    CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
    CHAINS.sepolia.chainId,
    DEFAULT_ADDRESSES.chainAlertRegistry
  ),
  programmableTokenSender: primaryFromMap(
    PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID,
    CHAINS.sepolia.chainId,
    DEFAULT_ADDRESSES.programmableTokenSender
  ),
  programmableTokenReceiver: primaryFromMap(
    PROGRAMMABLE_TOKEN_RECEIVER_BY_DEST_CHAIN_ID,
    CHAINS.amoy.chainId,
    DEFAULT_ADDRESSES.programmableTokenReceiver
  ),
  chainRegistry: asAddressOrFallback(process.env.CHAIN_REGISTRY_ADDRESS, DEFAULT_ADDRESSES.chainRegistry),
  tokenVerifier: asAddressOrFallback(process.env.TOKEN_VERIFIER_ADDRESS, DEFAULT_ADDRESSES.tokenVerifier),
  linkToken: primaryFromMap(LINK_TOKEN_BY_CHAIN_ID, CHAINS.sepolia.chainId, DEFAULT_ADDRESSES.linkToken),
} as const

// ─── CRE Workflow HTTP endpoints ──────────────────────────────────────────────
// These are the DON-hosted HTTP trigger URLs for each deployed workflow.
// Obtain these from: cre workflow list

export const WORKFLOW_ENDPOINTS = {
  autoPilotDCA:      process.env.AUTOPILOT_DCA_ENDPOINT      ?? "",
  chainShield:       process.env.CHAINSHIELD_ENDPOINT        ?? "",
  crossVault:        process.env.CROSSVAULT_ENDPOINT         ?? "",
  chainAlert:        process.env.CHAINALERT_ENDPOINT         ?? "",
} as const

// ─── CCIP Explorer ────────────────────────────────────────────────────────────

export const CCIP_EXPLORER = "https://ccip.chain.link/msg"

export function buildCCIPLink(messageId: string): string {
  return `${CCIP_EXPLORER}/${messageId}`
}

// ─── Destination chain display options ───────────────────────────────────────

export const DESTINATION_CHAIN_OPTIONS: Array<{ title: string; value: ChainKey }> = Object.entries(CHAINS)
  .filter(([key]) => key !== "sepolia")
  .map(([key, chain]) => ({ title: chain.name, value: key as ChainKey }))

export const DESTINATION_BY_CHAIN_ID: Record<number, ChainKey> = Object.fromEntries(
  Object.entries(CHAINS).map(([key, chain]) => [chain.chainId, key as ChainKey])
) as Record<number, ChainKey>

export function getChainById(chainId: number): (typeof CHAINS)[ChainKey] | undefined {
  const key = DESTINATION_BY_CHAIN_ID[chainId]
  return key ? CHAINS[key] : undefined
}

export function getChainByKey(key: ChainKey): (typeof CHAINS)[ChainKey] {
  return CHAINS[key]
}

export const BRIDGE_CONFIG = {
  host: process.env.ORCHESTRATOR_BRIDGE_HOST ?? "127.0.0.1",
  port: Number(process.env.ORCHESTRATOR_BRIDGE_PORT ?? "8787"),
  sessionTtlSeconds: Number(process.env.ORCHESTRATOR_SESSION_TTL_SECONDS ?? "86400"),
  intentTtlSeconds: Number(process.env.ORCHESTRATOR_INTENT_TTL_SECONDS ?? "900"),
  allowedOrigins: (process.env.ORCHESTRATOR_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
}

export const CONFIDENTIAL_COMPUTE = {
  enabledByDefault: boolFromEnv(process.env.CONFIDENTIAL_COMPUTE_ENABLED_BY_DEFAULT, false),
  strict: boolFromEnv(process.env.CONFIDENTIAL_COMPUTE_STRICT, false),
  provider: "CONVERGENCE_2026_TOKEN_API" as const,
  tokenApiBaseUrl: process.env.CONFIDENTIAL_TOKEN_API_BASE_URL ?? "https://convergence2026-token-api.cldev.cloud",
  hideSenderDefault: boolFromEnv(process.env.CONFIDENTIAL_HIDE_SENDER_BY_DEFAULT, true),
  eip712Domain: {
    name: process.env.CONFIDENTIAL_EIP712_NAME ?? "CompliantPrivateTokenDemo",
    version: process.env.CONFIDENTIAL_EIP712_VERSION ?? "0.0.1",
    chainId: Number(process.env.CONFIDENTIAL_EIP712_CHAIN_ID ?? String(CHAINS.sepolia.chainId)),
    verifyingContract: asAddressOrFallback(
      process.env.CONFIDENTIAL_EIP712_VERIFYING_CONTRACT,
      "0xB5A1f2D8A0f2F7BA0cB5E95c6B2BfAD8b6A66701" as Address
    ),
  },
}

const sepoliaTokenPresets: TokenPreset[] = [
  {
    symbol: "LINK",
    label: "Chainlink LINK (Sepolia)",
    address: (LINK_TOKEN_BY_CHAIN_ID[CHAINS.sepolia.chainId] ?? CONTRACTS.linkToken) as Address,
    decimals: 18,
  },
  {
    symbol: "CCIP-BnM",
    label: "CCIP-BnM (Sepolia)",
    address: (process.env.SEPOLIA_BNM_ADDRESS ??
      "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05") as `0x${string}`,
    decimals: Number(process.env.SEPOLIA_BNM_DECIMALS ?? "18"),
  },
]

function optionalToken(envPrefix: string, symbol: string, label: string): TokenPreset | null {
  const address = process.env[`${envPrefix}_TOKEN_ADDRESS`]
  if (!address || !isAddressLike(address)) return null
  return {
    symbol,
    label,
    address: address as Address,
    decimals: Number(process.env[`${envPrefix}_TOKEN_DECIMALS`] ?? "18"),
  }
}

export const TOKEN_PRESETS_BY_CHAIN_ID: Record<number, TokenPreset[]> = {
  11155111: sepoliaTokenPresets,
  421614: [optionalToken("ARBITRUM_SEPOLIA_BNM", "CCIP-BnM", "CCIP-BnM (Arbitrum Sepolia)")].filter(
    (v): v is TokenPreset => Boolean(v)
  ),
  84532: [optionalToken("BASE_SEPOLIA_BNM", "CCIP-BnM", "CCIP-BnM (Base Sepolia)")].filter(
    (v): v is TokenPreset => Boolean(v)
  ),
  80002: [optionalToken("AMOY_BNM", "CCIP-BnM", "CCIP-BnM (Polygon Amoy)")].filter(
    (v): v is TokenPreset => Boolean(v)
  ),
  43113: [optionalToken("FUJI_BNM", "CCIP-BnM", "CCIP-BnM (Avalanche Fuji)")].filter(
    (v): v is TokenPreset => Boolean(v)
  ),
}

const defaultDcaSourceChains = mapChainIds(AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID)
const defaultChainShieldSourceChains = mapChainIds(TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID)
const defaultCrossVaultSourceChains = mapChainIds(PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID)
const defaultChainAlertSourceChains = mapChainIds(CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID)

export const SUPPORTED_SOURCE_CHAINS_BY_ACTION: Record<string, number[]> = {
  DCA_CREATE_TIMED_ORDER: parseSourceChains("DCA_SOURCE_CHAIN_IDS", defaultDcaSourceChains),
  DCA_SET_ORDER_PAUSED: parseSourceChains("DCA_SOURCE_CHAIN_IDS", defaultDcaSourceChains),
  DCA_CANCEL_ORDER: parseSourceChains("DCA_SOURCE_CHAIN_IDS", defaultDcaSourceChains),
  DCA_FUND_LINK: parseSourceChains("DCA_SOURCE_CHAIN_IDS", defaultDcaSourceChains),
  CHAINALERT_UPSERT_RULE: parseSourceChains("CHAINALERT_SOURCE_CHAIN_IDS", defaultChainAlertSourceChains),
  CHAINALERT_SET_RULE_ENABLED: parseSourceChains("CHAINALERT_SOURCE_CHAIN_IDS", defaultChainAlertSourceChains),
  CHAINSHIELD_TRANSFER: parseSourceChains("CHAINSHIELD_SOURCE_CHAIN_IDS", defaultChainShieldSourceChains),
  CROSSVAULT_DEPOSIT: parseSourceChains("CROSSVAULT_SOURCE_CHAIN_IDS", defaultCrossVaultSourceChains),
}
