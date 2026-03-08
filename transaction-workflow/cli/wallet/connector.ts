// cli/wallet/connector.ts
// Handles wallet connection for CLI orchestration.
//
// Modes:
// - privateKey: local signer for fast dev/testing.
// - webSigner: MetaMask extension signs via localhost bridge + web signer app.
// - readOnly: no signing.

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  formatEther,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { CHAINS } from "../config.js"
import { warnBox, successBox, errorBox, infoBox } from "../utils/display.js"
import { askSelect, askSecret, pressEnter } from "../utils/input.js"
import { createSession, getSessionWallet } from "../bridge/runtime.js"

export interface WalletSession {
  address: `0x${string}`
  chainId: number
  chainName: string
  balance: bigint
  balanceEth: string
  publicClient: PublicClient
  walletClient: WalletClient
  account: Account
  mode: "privateKey" | "webSigner" | "readOnly"
  bridgeSessionId?: string
  bridgeToken?: string
  bridgeBaseUrl?: string
  signerUrl?: string
}

const viemChains: Record<string, Chain> = {
  sepolia: {
    id: 11155111,
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.sepolia.rpcUrl] } },
    blockExplorers: { default: { name: "Etherscan", url: CHAINS.sepolia.blockExplorer } },
    testnet: true,
  },
  amoy: {
    id: 80002,
    name: "Polygon Amoy",
    nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.amoy.rpcUrl] } },
    blockExplorers: { default: { name: "PolygonScan", url: CHAINS.amoy.blockExplorer } },
    testnet: true,
  },
  arbitrumSepolia: {
    id: 421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.arbitrumSepolia.rpcUrl] } },
    blockExplorers: { default: { name: "Arbiscan", url: CHAINS.arbitrumSepolia.blockExplorer } },
    testnet: true,
  },
  baseSepolia: {
    id: 84532,
    name: "Base Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.baseSepolia.rpcUrl] } },
    blockExplorers: { default: { name: "BaseScan", url: CHAINS.baseSepolia.blockExplorer } },
    testnet: true,
  },
  fuji: {
    id: 43113,
    name: "Avalanche Fuji",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.fuji.rpcUrl] } },
    blockExplorers: { default: { name: "SnowTrace", url: CHAINS.fuji.blockExplorer } },
    testnet: true,
  },
}

export async function connect(): Promise<WalletSession | null> {
  const mode = await askSelect("How would you like to connect?", [
    {
      title: "Private Key  (local development)",
      value: "privateKey" as const,
      description: "Paste a private key for fast local execution",
    },
    {
      title: "MetaMask Web Signer  (recommended)",
      value: "webSigner" as const,
      description: "Connect MetaMask in browser and sign via localhost bridge",
    },
    {
      title: "Read-only  (no transactions)",
      value: "readOnly" as const,
      description: "View balances and state without signing",
    },
  ])

  if (!mode) return null

  switch (mode) {
    case "privateKey":
      return connectWithPrivateKey()
    case "webSigner":
      return connectWithWebSigner()
    case "readOnly":
      return connectReadOnly()
  }
}

async function connectWithPrivateKey(): Promise<WalletSession | null> {
  warnBox("Never use a private key holding real funds. Testnet keys only.")

  const raw = await askSecret("Enter your private key (0x...)")
  if (!raw) return null

  const key = raw.startsWith("0x") ? (raw as `0x${string}`) : (`0x${raw}` as `0x${string}`)

  let account: Account
  try {
    account = privateKeyToAccount(key)
  } catch {
    errorBox("Invalid private key format.")
    return null
  }

  const chain = viemChains.sepolia
  const publicClient = createPublicClient({ chain, transport: http(CHAINS.sepolia.rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(CHAINS.sepolia.rpcUrl) })
  let balance = 0n
  try {
    balance = await publicClient.getBalance({ address: account.address })
  } catch (err) {
    warnBox(`RPC balance check failed (${String(err)}). Continuing with 0 ETH shown.`)
  }

  successBox(`Connected: ${account.address}`)

  return {
    address: account.address,
    chainId: chain.id,
    chainName: chain.name,
    balance,
    balanceEth: parseFloat(formatEther(balance)).toFixed(4),
    publicClient,
    walletClient,
    account,
    mode: "privateKey",
  }
}

async function waitForWebSignerWallet(sessionId: string, timeoutMs: number): Promise<{ account: `0x${string}`; chainId: number } | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const wallet = getSessionWallet(sessionId)
    if (wallet?.account && wallet.chainId) {
      return { account: wallet.account, chainId: wallet.chainId }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

async function connectWithWebSigner(): Promise<WalletSession | null> {
  const session = createSession()
  infoBox(
    "Open the web signer and connect MetaMask:\n" +
      `  ${session.signerUrlHint}\n\n` +
      "Keep this CLI running, then approve connection in browser."
  )
  infoBox(`Bridge API: ${session.baseUrl}  (session expires at ${session.expiresAt})`)
  infoBox(
    `Confidential mode at session start: ${session.confidentialMode.enabled ? "ON" : "OFF"}\n` +
      `Provider: ${session.confidentialMode.provider}\n` +
      `Strict policy: ${session.confidentialMode.strict ? "ON" : "OFF"}`
  )

  const ready = await waitForWebSignerWallet(session.sessionId, 5 * 60 * 1000)
  if (!ready) {
    warnBox("Timed out waiting for MetaMask connection in web signer.")
    await pressEnter("Press Enter to continue")
    return null
  }

  const chainEntry =
    Object.values(CHAINS).find((c) => c.chainId === ready.chainId) ?? CHAINS.sepolia
  const chain =
    Object.values(viemChains).find((c) => c.id === ready.chainId) ?? viemChains.sepolia

  const publicClient = createPublicClient({ chain, transport: http(chainEntry.rpcUrl) })
  let balance = 0n
  try {
    balance = await publicClient.getBalance({ address: ready.account })
  } catch (err) {
    warnBox(`RPC balance check failed (${String(err)}). Continuing with 0 ETH shown.`)
  }
  const walletClient = createWalletClient({
    chain,
    transport: http(chainEntry.rpcUrl),
  }) as WalletClient

  successBox(`MetaMask connected: ${ready.account}`)

  return {
    address: ready.account,
    chainId: chain.id,
    chainName: chain.name,
    balance,
    balanceEth: parseFloat(formatEther(balance)).toFixed(4),
    publicClient,
    walletClient,
    account: { address: ready.account, type: "json-rpc" } as Account,
    mode: "webSigner",
    bridgeSessionId: session.sessionId,
    bridgeToken: session.token,
    bridgeBaseUrl: session.baseUrl,
    signerUrl: session.signerUrlHint,
  }
}

async function connectReadOnly(): Promise<WalletSession | null> {
  const { askAddress } = await import("../utils/input.js")
  const address = await askAddress("Enter the wallet address to monitor")
  if (!address) return null

  const chain = viemChains.sepolia
  const publicClient = createPublicClient({ chain, transport: http(CHAINS.sepolia.rpcUrl) })
  let balance = 0n
  try {
    balance = await publicClient.getBalance({ address })
  } catch (err) {
    warnBox(`RPC balance check failed (${String(err)}). Continuing with 0 ETH shown.`)
  }
  const walletClient = createWalletClient({
    chain,
    transport: http(CHAINS.sepolia.rpcUrl),
  }) as WalletClient

  successBox(`Monitoring: ${address} (read-only)`)

  return {
    address,
    chainId: chain.id,
    chainName: chain.name,
    balance,
    balanceEth: parseFloat(formatEther(balance)).toFixed(4),
    publicClient,
    walletClient,
    account: { address, type: "json-rpc" } as Account,
    mode: "readOnly",
  }
}

export function requireSigning(session: WalletSession): boolean {
  if (session.mode === "readOnly") {
    warnBox("This action requires a signer connection. Reconnect with private key or MetaMask Web Signer.")
    return false
  }
  return true
}
