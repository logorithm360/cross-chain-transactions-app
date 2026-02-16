/**
 * RPC Client Module
 * 
 * Handles blockchain RPC calls using viem.
 * Supports multiple chains via Infura or other RPC providers.
 */

import { createPublicClient, http, PublicClient, Chain } from "viem";
import "dotenv/config";

// ============================================================================
// Chain Configurations
// ============================================================================

export interface ChainConfig {
  name: string;
  chain: Chain;
  defaultRpc: string;
}

// Helper to safely get Infura key
const getInfuraKey = (): string => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env.INFURA_API_KEY || '';
  }
  return '';
};

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    name: "Ethereum Mainnet",
    chain: {
      id: 1,
      name: "Ethereum Mainnet",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://mainnet.infura.io/v3/${getInfuraKey()}`
  },
  5: {
    name: "Goerli Testnet",
    chain: {
      id: 5,
      name: "Goerli",
      nativeCurrency: { name: "Goerli Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://goerli.infura.io/v3/${getInfuraKey()}`
  },
  11155111: {
    name: "Sepolia Testnet",
    chain: {
      id: 11155111,
      name: "Sepolia",
      nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://sepolia.infura.io/v3/${getInfuraKey()}`
  },
  56: {
    name: "BSC Mainnet",
    chain: {
      id: 56,
      name: "BNB Smart Chain",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://bsc-dataseed.binance.org`
  },
  137: {
    name: "Polygon Mainnet",
    chain: {
      id: 137,
      name: "Polygon",
      nativeCurrency: { name: "MATIC", symbol: "MATIC", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://polygon-rpc.com`
  },
  42161: {
    name: "Arbitrum One",
    chain: {
      id: 42161,
      name: "Arbitrum One",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://arb1.arbitrum.io/rpc`
  },
  10: {
    name: "Optimism",
    chain: {
      id: 10,
      name: "Optimism",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: {
        default: { http: [] },
        public: { http: [] }
      }
    },
    defaultRpc: `https://mainnet.optimism.io`
  }
};

// ============================================================================
// Client Cache
// ============================================================================

const clientCache: Map<string, PublicClient> = new Map();

function getCacheKey(rpcUrl: string, chainId: number): string {
  return `${chainId}-${rpcUrl}`;
}

// ============================================================================
// Public Client Factory
// ============================================================================

/**
 * Creates or retrieves a cached viem PublicClient
 */
export function getPublicClient(chainId: number, rpcUrl?: string): PublicClient {
  const chainConfig = CHAINS[chainId];
  
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}. Supported chains: ${Object.keys(CHAINS).join(", ")}`);
  }

  // Use provided RPC URL, or fall back to Infura from environment
  const finalRpcUrl = rpcUrl || chainConfig.defaultRpc;
  
  if (!finalRpcUrl || finalRpcUrl.includes("undefined")) {
    throw new Error(`No RPC URL configured for chain ${chainId}. Please set INFURA_API_KEY in .env or provide an RPC URL.`);
  }

  const cacheKey = getCacheKey(finalRpcUrl, chainId);
  
  // Return cached client if available
  if (clientCache.has(cacheKey)) {
    return clientCache.get(cacheKey)!;
  }

  // Create new client
  const client = createPublicClient({
    chain: chainConfig.chain,
    transport: http(finalRpcUrl, {
      timeout: 30000 // 30 second timeout
    })
  });

  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Creates a new client (bypasses cache) - useful for one-off requests
 */
export function createClient(chainId: number, rpcUrl?: string): PublicClient {
  const chainConfig = CHAINS[chainId];
  
  if (!chainConfig) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const finalRpcUrl = rpcUrl || chainConfig.defaultRpc;
  
  if (!finalRpcUrl || finalRpcUrl.includes("undefined")) {
    throw new Error(`No RPC URL configured for chain ${chainId}`);
  }

  return createPublicClient({
    chain: chainConfig.chain,
    transport: http(finalRpcUrl, {
      timeout: 30000
    })
  });
}

// ============================================================================
// RPC Functions
// ============================================================================

/**
 * Gets the bytecode of a contract at the given address
 */
export async function getBytecode(
  address: string,
  chainId: number = 1,
  rpcUrl?: string
): Promise<string> {
  const client = getPublicClient(chainId, rpcUrl);
  
  try {
    const bytecode = await client.getBytecode({
      address: address as `0x${string}`
    });
    
    return bytecode || "0x";
  } catch (error) {
    console.error(`Error fetching bytecode for ${address} on chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Gets the balance of an address
 */
export async function getBalance(
  address: string,
  chainId: number = 1,
  rpcUrl?: string
): Promise<bigint> {
  const client = getPublicClient(chainId, rpcUrl);
  
  try {
    const balance = await client.getBalance({
      address: address as `0x${string}`
    });
    
    return balance;
  } catch (error) {
    console.error(`Error fetching balance for ${address} on chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Gets the current block number
 */
export async function getBlockNumber(
  chainId: number = 1,
  rpcUrl?: string
): Promise<number> {
  const client = getPublicClient(chainId, rpcUrl);
  
  try {
    const blockNumber = await client.getBlockNumber();
    return Number(blockNumber);
  } catch (error) {
    console.error(`Error fetching block number for chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Gets a transaction by hash
 */
export async function getTransactionByHash(
  txHash: string,
  chainId: number = 1,
  rpcUrl?: string
) {
  const client = getPublicClient(chainId, rpcUrl);
  
  try {
    const transaction = await client.getTransaction({
      hash: txHash as `0x${string}`
    });
    
    return transaction;
  } catch (error) {
    console.error(`Error fetching transaction ${txHash} on chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Gets multiple bytecodes in batch (for token security checks)
 */
export async function getBytecodes(
  addresses: string[],
  chainId: number = 1,
  rpcUrl?: string
): Promise<Record<string, string>> {
  const client = getPublicClient(chainId, rpcUrl);
  
  try {
    const results: Record<string, string> = {};
    
    // Use multicall for better performance if available, otherwise sequential
    await Promise.all(
      addresses.map(async (address) => {
        try {
          const bytecode = await client.getBytecode({
            address: address as `0x${string}`
          });
          results[address.toLowerCase()] = bytecode || "0x";
        } catch (error) {
          console.error(`Error fetching bytecode for ${address}:`, error);
          results[address.toLowerCase()] = "0x";
        }
      })
    );
    
    return results;
  } catch (error) {
    console.error(`Error fetching bytecodes for chain ${chainId}:`, error);
    throw error;
  }
}

/**
 * Checks if an address is a contract (has non-empty bytecode)
 */
export async function isContract(
  address: string,
  chainId: number = 1,
  rpcUrl?: string
): Promise<boolean> {
  const bytecode = await getBytecode(address, chainId, rpcUrl);
  return bytecode !== "0x" && bytecode !== "";
}

/**
 * Gets chain ID from RPC URL (useful for validation)
 */
export async function getChainIdFromRpc(rpcUrl: string): Promise<number> {
  const client = createPublicClient({
    transport: http(rpcUrl)
  });
  
  return Number(await client.getChainId());
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Validates if an RPC URL is accessible
 */
export async function validateRpcUrl(rpcUrl: string): Promise<{
  isValid: boolean;
  chainId?: number;
  error?: string;
}> {
  try {
    const chainId = await getChainIdFromRpc(rpcUrl);
    return { isValid: true, chainId };
  } catch (error) {
    return {
      isValid: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

/**
 * Gets the default RPC URL for a chain (requires INFURA_API_KEY)
 */
export function getDefaultRpcUrl(chainId: number): string | null {
  const chainConfig = CHAINS[chainId];
  
  if (!chainConfig) {
    return null;
  }
  
  // Check if Infura key is available
  if (!process.env.INFURA_API_KEY) {
    console.warn("INFURA_API_KEY not found in environment. Default RPC URLs requiring Infura will not work.");
    return null;
  }
  
  return chainConfig.defaultRpc;
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  getPublicClient,
  createClient,
  getBytecode,
  getBalance,
  getBlockNumber,
  getTransactionByHash,
  getBytecodes,
  isContract,
  getChainIdFromRpc,
  validateRpcUrl,
  getDefaultRpcUrl,
  CHAINS
};

