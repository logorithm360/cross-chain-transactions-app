// cli/wallet/connector.ts
// Handles wallet connection.
//
// Two modes:
//   PRIVATE KEY — for local dev. User pastes a key, viem creates a wallet client.
//   WALLETCONNECT — for production. Generates a pairing URI the user scans in MetaMask mobile.
//
// The session object returned from connect() is passed throughout the CLI
// so every screen knows who is connected and can sign transactions.

import {
  createPublicClient,
  createWalletClient,
  http,
  publicActions,
  type PublicClient,
  type WalletClient,
  type Account,
  type Chain,
  formatEther,
  privateKeyToAccount,
} from "viem"
import { sepolia } from "viem/chains"
import { CHAINS }  from "../config.js"
import { c, warnBox, successBox, errorBox, infoBox } from "../utils/display.js"
import { askSelect, askSecret, pressEnter }          from "../utils/input.js"

// ─── Session type — passed through entire CLI after connection ────────────────

export interface WalletSession {
  address:      `0x${string}`
  chainId:      number
  chainName:    string
  balance:      bigint       // in wei
  balanceEth:   string       // formatted
  publicClient: PublicClient
  walletClient: WalletClient
  account:      Account
  mode:         "privateKey" | "walletConnect" | "readOnly"
}

// ─── Viem chain objects for all five supported chains ─────────────────────────

const viemChains: Record<string, Chain> = {
  sepolia: {
    id:   11155111,
    name: "Ethereum Sepolia",
    nativeCurrency: { name: "Ether",  symbol: "ETH",   decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.sepolia.rpcUrl] } },
    blockExplorers: { default: { name: "Etherscan", url: CHAINS.sepolia.blockExplorer } },
    testnet: true,
  },
  amoy: {
    id:   80002,
    name: "Polygon Amoy",
    nativeCurrency: { name: "MATIC",  symbol: "MATIC", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.amoy.rpcUrl] } },
    blockExplorers: { default: { name: "PolygonScan", url: CHAINS.amoy.blockExplorer } },
    testnet: true,
  },
  arbitrumSepolia: {
    id:   421614,
    name: "Arbitrum Sepolia",
    nativeCurrency: { name: "Ether",  symbol: "ETH",   decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.arbitrumSepolia.rpcUrl] } },
    blockExplorers: { default: { name: "Arbiscan", url: CHAINS.arbitrumSepolia.blockExplorer } },
    testnet: true,
  },
  baseSepolia: {
    id:   84532,
    name: "Base Sepolia",
    nativeCurrency: { name: "Ether",  symbol: "ETH",   decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.baseSepolia.rpcUrl] } },
    blockExplorers: { default: { name: "BaseScan", url: CHAINS.baseSepolia.blockExplorer } },
    testnet: true,
  },
  fuji: {
    id:   43113,
    name: "Avalanche Fuji",
    nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
    rpcUrls: { default: { http: [CHAINS.fuji.rpcUrl] } },
    blockExplorers: { default: { name: "SnowTrace", url: CHAINS.fuji.blockExplorer } },
    testnet: true,
  },
}

// ─── Connection mode selection ────────────────────────────────────────────────

export async function connect(): Promise<WalletSession | null> {
  const mode = await askSelect("How would you like to connect?", [
    {
      title:       "Private Key  (local development)",
      value:       "privateKey" as const,
      description: "Paste a private key — fast, for testing only",
    },
    {
      title:       "WalletConnect  (MetaMask mobile / browser extension)",
      value:       "walletConnect" as const,
      description: "Scan a QR code or deep-link from MetaMask",
    },
    {
      title:       "Read-only  (no transactions)",
      value:       "readOnly" as const,
      description: "View balances and orders without signing anything",
    },
  ])

  if (!mode) return null

  switch (mode) {
    case "privateKey":    return connectWithPrivateKey()
    case "walletConnect": return connectWithWalletConnect()
    case "readOnly":      return connectReadOnly()
  }
}

// ─── Private key connection ───────────────────────────────────────────────────

async function connectWithPrivateKey(): Promise<WalletSession | null> {
  warnBox("Never use a private key holding real funds. Testnet keys only.")

  const raw = await askSecret("Enter your private key (0x...)")
  if (!raw) return null

  const key = raw.startsWith("0x") ? raw as `0x${string}` : `0x${raw}` as `0x${string}`

  let account: Account
  try {
    account = privateKeyToAccount(key)
  } catch {
    errorBox("Invalid private key format.")
    return null
  }

  // Default to Sepolia — where the contracts are deployed
  const chain        = viemChains.sepolia
  const publicClient = createPublicClient({ chain, transport: http(CHAINS.sepolia.rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(CHAINS.sepolia.rpcUrl) })

  const balance    = await publicClient.getBalance({ address: account.address })
  const balanceEth = parseFloat(formatEther(balance)).toFixed(4)

  successBox(`Connected: ${account.address}`)

  return {
    address:     account.address,
    chainId:     chain.id,
    chainName:   chain.name,
    balance,
    balanceEth,
    publicClient,
    walletClient,
    account,
    mode:        "privateKey",
  }
}

// ─── WalletConnect connection ─────────────────────────────────────────────────
// Full WalletConnect v2 integration requires @walletconnect/web3wallet.
// This implementation shows the correct flow — install the package when
// you are ready to wire up MetaMask browser/mobile.

async function connectWithWalletConnect(): Promise<WalletSession | null> {
  infoBox(
    "WalletConnect requires the @walletconnect/web3wallet package.\n" +
    "  Run: bun add @walletconnect/web3wallet @walletconnect/utils\n\n" +
    "  Once installed, the flow works like this:\n" +
    "  1. A pairing URI is generated and shown as a QR code\n" +
    "  2. Open MetaMask → Scan QR  (or click the deep-link on mobile)\n" +
    "  3. Approve the connection in MetaMask\n" +
    "  4. The CLI receives your address and can request signatures"
  )

  // ── Stub: replace this block with real WalletConnect v2 init ──
  //
  // import { WalletConnectModal } from "@walletconnect/modal"
  // import { SignClient } from "@walletconnect/sign-client"
  //
  // const signClient = await SignClient.init({
  //   projectId: process.env.WALLETCONNECT_PROJECT_ID,
  //   metadata: {
  //     name: "CRE Suite",
  //     description: "Chainlink DeFi Terminal",
  //     url: "https://cre-suite.local",
  //     icons: [],
  //   },
  // })
  //
  // const { uri, approval } = await signClient.connect({
  //   requiredNamespaces: {
  //     eip155: {
  //       methods: ["eth_sendTransaction", "personal_sign"],
  //       chains:  ["eip155:11155111"],
  //       events:  ["accountsChanged", "chainChanged"],
  //     },
  //   },
  // })
  //
  // console.log(`\n  Scan this URI in MetaMask:\n  ${uri}\n`)
  // const session = await approval()
  // const address = session.namespaces.eip155.accounts[0].split(":")[2]
  // ── End stub ──

  await pressEnter("WalletConnect not yet configured — press Enter to go back")
  return null
}

// ─── Read-only connection ─────────────────────────────────────────────────────

async function connectReadOnly(): Promise<WalletSession | null> {
  const { askAddress } = await import("../utils/input.js")
  const address = await askAddress("Enter the wallet address to monitor")
  if (!address) return null

  const chain        = viemChains.sepolia
  const publicClient = createPublicClient({ chain, transport: http(CHAINS.sepolia.rpcUrl) })

  const balance    = await publicClient.getBalance({ address })
  const balanceEth = parseFloat(formatEther(balance)).toFixed(4)

  // Read-only mode: walletClient is a no-op placeholder
  const walletClient = createWalletClient({
    chain,
    transport: http(CHAINS.sepolia.rpcUrl),
  }) as WalletClient

  successBox(`Monitoring: ${address}  (read-only)`)

  return {
    address,
    chainId:     chain.id,
    chainName:   chain.name,
    balance,
    balanceEth,
    publicClient,
    walletClient,
    account:     { address, type: "json-rpc" } as Account,
    mode:        "readOnly",
  }
}

// ─── Guard: requires a signing wallet ────────────────────────────────────────

export function requireSigning(session: WalletSession): boolean {
  if (session.mode === "readOnly") {
    warnBox("This action requires a wallet that can sign transactions. Reconnect with a private key or WalletConnect.")
    return false
  }
  return true
}
