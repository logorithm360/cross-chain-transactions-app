/**
 * Etherscan API Integration Module
 * 
 * Handles all interactions with the Etherscan API for:
 * - Contract source code verification status
 * - Contract ABI retrieval
 * - Token information (name, symbol, decimals)
 * - Contract creation bytecode
 */

import {
  EtherscanSourceCodeResponse
} from "./types";

// ============================================================================
// Chain Configuration
// ============================================================================

export interface ChainConfig {
  name: string;
  explorerUrl: string;
  apiBaseUrl: string;
}

export const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  1: {
    name: "Ethereum Mainnet",
    explorerUrl: "https://api.etherscan.io",
    apiBaseUrl: "https://api.etherscan.io/api"
  },
  5: {
    name: "Goerli Testnet",
    explorerUrl: "https://api-goerli.etherscan.io",
    apiBaseUrl: "https://api-goerli.etherscan.io/api"
  },
  11155111: {
    name: "Sepolia Testnet",
    explorerUrl: "https://api-sepolia.etherscan.io",
    apiBaseUrl: "https://api-sepolia.etherscan.io/api"
  },
  56: {
    name: "BSC Mainnet",
    explorerUrl: "https://api.bscscan.com",
    apiBaseUrl: "https://api.bscscan.com/api"
  },
  97: {
    name: "BSC Testnet",
    explorerUrl: "https://api-testnet.bscscan.com",
    apiBaseUrl: "https://api-testnet.bscscan.com/api"
  },
  137: {
    name: "Polygon Mainnet",
    explorerUrl: "https://api.polygonscan.com",
    apiBaseUrl: "https://api.polygonscan.com/api"
  },
  80001: {
    name: "Polygon Mumbai",
    explorerUrl: "https://api-mumbai.polygonscan.com",
    apiBaseUrl: "https://api-mumbai.polygonscan.com/api"
  },
  42161: {
    name: "Arbitrum One",
    explorerUrl: "https://api.arbiscan.io",
    apiBaseUrl: "https://api.arbiscan.io/api"
  },
  421613: {
    name: "Arbitrum Goerli",
    explorerUrl: "https://api-goerli.arbiscan.io",
    apiBaseUrl: "https://api-goerli.arbiscan.io/api"
  },
  10: {
    name: "Optimism",
    explorerUrl: "https://api-optimistic.etherscan.io",
    apiBaseUrl: "https://api-optimistic.etherscan.io/api"
  },
  420: {
    name: "Optimism Goerli",
    explorerUrl: "https://api-goerli-optimistic.etherscan.io",
    apiBaseUrl: "https://api-goerli-optimistic.etherscan.io/api"
  }
};

// ============================================================================
// Etherscan API Client
// ============================================================================

export class EtherscanClient {
  private apiKey: string;
  private chainId: number;
  private baseUrl: string;
  private timeout: number;

  constructor(apiKey: string, chainId: number = 1, timeout: number = 30000) {
    this.apiKey = apiKey;
    this.chainId = chainId;
    this.timeout = timeout;

    const chainConfig = CHAIN_CONFIGS[chainId];
    if (!chainConfig) {
      throw new Error(`Unsupported chain ID: ${chainId}`);
    }
    this.baseUrl = chainConfig.apiBaseUrl;
  }

  /**
   * Makes a request to the Etherscan API
   */
  private async request<T>(params: Record<string, string>): Promise<T> {
    const queryString = new URLSearchParams({
      ...params,
      apikey: this.apiKey
    }).toString();

    const timeoutId = setTimeout(() => {
      throw new Error("Request timeout");
    }, this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}?${queryString}`, {
        headers: {
          "Accept": "application/json"
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
      }

      const data = await response.json() as T;
      
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  /**
   * Gets contract source code and verification status
   */
  async getSourceCode(address: string): Promise<EtherscanSourceCodeResponse> {
    return this.request<EtherscanSourceCodeResponse>({
      module: "contract",
      action: "getsourcecode",
      address
    });
  }

  /**
   * Gets contract ABI
   */
  async getAbi(address: string): Promise<string> {
    const response = await this.request<{
      status: string;
      message: string;
      result: string;
    }>({
      module: "contract",
      action: "getabi",
      address
    });

    return response.result;
  }

  /**
   * Checks if an address is a verified contract
   */
  async isVerified(address: string): Promise<boolean> {
    try {
      const sourceCode = await this.getSourceCode(address);
      return sourceCode.result.length > 0 && 
             sourceCode.result[0].SourceCode !== "" &&
             sourceCode.result[0].ABI !== "Contract source code not verified";
    } catch {
      return false;
    }
  }

  /**
   * Gets token information
   */
  async getTokenInfo(address: string): Promise<{
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    tokenType: string | null;
  }> {
    try {
      const sourceCode = await this.getSourceCode(address);
      
      if (sourceCode.result.length === 0 || sourceCode.result[0].SourceCode === "") {
        return { name: null, symbol: null, decimals: null, tokenType: null };
      }

      const contractName = sourceCode.result[0].ContractName;
      const abiStr = sourceCode.result[0].ABI;
      
      if (abiStr && abiStr !== "Contract source code not verified") {
        try {
          const abi = JSON.parse(abiStr);
          return {
            name: contractName,
            symbol: contractName.slice(0, 10).toUpperCase(),
            decimals: 18,
            tokenType: this.detectTokenTypeFromAbi(abi)
          };
        } catch {
          // ABI parsing failed
        }
      }

      return {
        name: contractName,
        symbol: null,
        decimals: null,
        tokenType: null
      };
    } catch {
      return { name: null, symbol: null, decimals: null, tokenType: null };
    }
  }

  /**
   * Detects token type from ABI
   */
  private detectTokenTypeFromAbi(abi: Array<{ type: string; name?: string }>): string | null {
    const functionNames = abi
      .filter(item => item.type === "function")
      .map(item => item.name?.toLowerCase() || "");

    const hasErc20 = ["balanceOf", "transfer", "approve"].every(fn => 
      functionNames.includes(fn.toLowerCase())
    );
    const hasErc721 = ["ownerOf", "transferFrom", "approve", "setApprovalForAll"].every(fn =>
      functionNames.includes(fn.toLowerCase())
    );
    const hasErc1155 = functionNames.includes("safeTransferFrom") && 
                      functionNames.includes("balanceOf");

    if (hasErc721) return "ERC721";
    if (hasErc1155) return "ERC1155";
    if (hasErc20) return "ERC20";

    return null;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates an Etherscan client for a given chain
 */
export function createEtherscanClient(
  apiKey: string,
  chainId: number = 1
): EtherscanClient {
  return new EtherscanClient(apiKey, chainId);
}

/**
 * Quick check if a contract is verified
 */
export async function isContractVerified(
  address: string,
  apiKey: string,
  chainId: number = 1
): Promise<boolean> {
  const client = createEtherscanClient(apiKey, chainId);
  return client.isVerified(address);
}

/**
 * Gets comprehensive token information
 */
export async function getTokenInfo(
  address: string,
  apiKey: string,
  chainId: number = 1
): Promise<{
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  tokenType: string | null;
  isVerified: boolean;
  contractName: string | null;
}> {
  const client = createEtherscanClient(apiKey, chainId);
  const [tokenInfo, sourceCode] = await Promise.all([
    client.getTokenInfo(address),
    client.getSourceCode(address)
  ]);

  return {
    ...tokenInfo,
    isVerified: sourceCode.result.length > 0 && sourceCode.result[0].SourceCode !== "",
    contractName: sourceCode.result[0]?.ContractName || null
  };
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  EtherscanClient,
  createEtherscanClient,
  isContractVerified,
  getTokenInfo,
  CHAIN_CONFIGS
};

