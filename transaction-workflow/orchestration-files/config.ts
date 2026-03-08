// cli/config.ts
// Single source of truth for all contract addresses, RPC URLs,
// and CRE workflow HTTP endpoints.
// Replace placeholder values with your deployed addresses before running.

export const CHAINS = {
  sepolia: {
    name:          "Ethereum Sepolia",
    chainId:       11155111,
    rpcUrl:        process.env.SEPOLIA_RPC_URL ?? "https://rpc.ankr.com/eth_sepolia",
    blockExplorer: "https://sepolia.etherscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  amoy: {
    name:          "Polygon Amoy",
    chainId:       80002,
    rpcUrl:        process.env.AMOY_RPC_URL ?? "https://rpc.ankr.com/polygon_amoy",
    blockExplorer: "https://amoy.polygonscan.com",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
  },
  arbitrumSepolia: {
    name:          "Arbitrum Sepolia",
    chainId:       421614,
    rpcUrl:        process.env.ARBITRUM_SEPOLIA_RPC_URL ?? "https://sepolia-rollup.arbitrum.io/rpc",
    blockExplorer: "https://sepolia.arbiscan.io",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  baseSepolia: {
    name:          "Base Sepolia",
    chainId:       84532,
    rpcUrl:        process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    blockExplorer: "https://sepolia.basescan.org",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  },
  fuji: {
    name:          "Avalanche Fuji",
    chainId:       43113,
    rpcUrl:        process.env.FUJI_RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
    blockExplorer: "https://testnet.snowtrace.io",
    nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  },
} as const

export type ChainKey = keyof typeof CHAINS

// ─── Contract addresses (all deployed on Sepolia unless noted) ────────────────

export const CONTRACTS = {
  // AutoPilot DCA
  automatedTrader: process.env.AUTOMATED_TRADER_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // AutomatedTraderReceiver lives on Amoy
  automatedTraderReceiver: process.env.AUTOMATED_TRADER_RECEIVER_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // ChainShield Transfer
  chainShieldTransfer: process.env.CHAIN_SHIELD_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // ChainAlert Intelligence registry
  chainAlertRegistry: process.env.CHAIN_ALERT_REGISTRY_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // Chain Registry (resolves chain configs — Feature 8)
  chainRegistry: process.env.CHAIN_REGISTRY_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // Token Verifier
  tokenVerifier: process.env.TOKEN_VERIFIER_ADDRESS ?? "REPLACE_WITH_DEPLOYED_ADDRESS",

  // LINK token on Sepolia
  linkToken: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
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

export const DESTINATION_CHAIN_OPTIONS = [
  { title: "Polygon Amoy",     value: "amoy"            },
  { title: "Arbitrum Sepolia", value: "arbitrumSepolia" },
  { title: "Base Sepolia",     value: "baseSepolia"     },
  { title: "Avalanche Fuji",   value: "fuji"            },
] as const
