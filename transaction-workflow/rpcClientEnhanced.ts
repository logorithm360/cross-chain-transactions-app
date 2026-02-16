/**
 * RPC Client Module - Enhanced
 *
 * Comprehensive RPC-based token verification across EVM chains
 * Queries blockchain directly for contract verification
 *
 * CRE Best Practices Implemented:
 * - Deterministic RPC calls
 * - Timeout management
 * - Error handling
 * - Multi-chain support
 * - JSON-serializable responses
 */

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface RPCConfig {
  rpcUrl: string;
  chainId: number;
  timeout: number;
}

export interface ContractBytecodeAnalysis {
  bytecode: string;
  bytecodeLength: number;
  isContract: boolean;
  hasCode: boolean;
}

export interface ERC20Metadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
}

export interface ContractFunctionSignatures {
  hasERC20: boolean;
  hasERC721: boolean;
  hasERC1155: boolean;
  selectors: string[];
}

// ============================================================================
// Chain RPC URLs
// ============================================================================

const RPC_ENDPOINTS: Record<number, string> = {
  1: "https://eth-mainnet.alchemyapi.io/v2/demo",
  5: "https://eth-goerli.alchemyapi.io/v2/demo",
  11155111: "https://eth-sepolia.alchemyapi.io/v2/demo",
  56: "https://bsc-dataseed.binance.org:443",
  97: "https://data-seed-prebsc.binance.org:8545",
  137: "https://polygon-rpc.com",
  80001: "https://rpc-mumbai.maticvigil.com",
  42161: "https://arb1.arbitrum.io/rpc",
  421613: "https://goerli-rollup.arbitrum.io/rpc",
  10: "https://mainnet.optimism.io",
  420: "https://goerli.optimism.io",
  8453: "https://mainnet.base.org",
  84532: "https://sepolia.base.org"
};

// ============================================================================
// ERC Function Selectors (4-byte signatures)
// ============================================================================

const ERC20_SELECTORS = {
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567"
};

const ERC721_SELECTORS = {
  ownerOf: "0x6352211e",
  balanceOf: "0x70a08231",
  safeTransferFrom: "0x42842e0e",
  setApprovalForAll: "0xa22cb465",
  isApprovedForAll: "0xe985e9c5",
  approve: "0x095ea7b3",
  getApproved: "0x081812fc"
};

const ERC1155_SELECTORS = {
  balanceOf: "0x00fdd58e",
  balanceOfBatch: "0x4e1273f4",
  setApprovalForAll: "0xa22cb465",
  isApprovedForAll: "0xe985e9c5",
  safeTransferFrom: "0xf242432a",
  safeBatchTransferFrom: "0x2eb2c2d6"
};

// ============================================================================
// RPC Client
// ============================================================================

export class RPCClient {
  private rpcUrl: string;
  private chainId: number;
  private timeout: number;

  constructor(config: RPCConfig) {
    this.rpcUrl = config.rpcUrl;
    this.chainId = config.chainId;
    this.timeout = config.timeout || 30000;
  }

  /**
   * Make JSON-RPC call
   */
  private async call<T>(
    method: string,
    params: unknown[]
  ): Promise<T> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          params,
          id: Date.now()
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json() as {
        jsonrpc: string;
        result?: T;
        error?: { message: string };
      };

      if (data.error) {
        throw new Error(data.error.message);
      }

      return data.result as T;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`RPC call failed: ${message}`);
    }
  }

  /**
   * Get contract bytecode
   */
  async getBytecode(address: string): Promise<ContractBytecodeAnalysis> {
    try {
      const bytecode = await this.call<string>("eth_getCode", [address.toLowerCase(), "latest"]);

      return {
        bytecode: bytecode || "0x",
        bytecodeLength: (bytecode?.length || 0) / 2,
        isContract: bytecode !== "0x" && bytecode !== "",
        hasCode: bytecode !== "0x" && bytecode !== ""
      };
    } catch (error) {
      throw new Error(`Failed to get bytecode: ${error}`);
    }
  }

  /**
   * Call contract method (read-only)
   */
  async callContractMethod(
    contractAddress: string,
    data: string
  ): Promise<string> {
    try {
      return await this.call<string>("eth_call", [
        {
          to: contractAddress.toLowerCase(),
          data
        },
        "latest"
      ]);
    } catch (error) {
      throw new Error(`Failed to call contract: ${error}`);
    }
  }

  /**
   * Get ERC20 name
   */
  async getERC20Name(tokenAddress: string): Promise<string | null> {
    try {
      const result = await this.callContractMethod(tokenAddress, ERC20_SELECTORS.name);
      if (result === "0x") return null;

      // Decode UTF-8 string from result
      const hexString = result.substring(2);
      const bytes = Buffer.from(hexString, "hex");
      const offset = parseInt(hexString.substring(0, 64), 16) / 2;
      const length = parseInt(hexString.substring(64, 128), 16);
      return bytes.toString("utf8", offset, offset + length).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get ERC20 symbol
   */
  async getERC20Symbol(tokenAddress: string): Promise<string | null> {
    try {
      const result = await this.callContractMethod(tokenAddress, ERC20_SELECTORS.symbol);
      if (result === "0x") return null;

      const hexString = result.substring(2);
      const bytes = Buffer.from(hexString, "hex");
      const offset = parseInt(hexString.substring(0, 64), 16) / 2;
      const length = parseInt(hexString.substring(64, 128), 16);
      return bytes.toString("utf8", offset, offset + length).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Get ERC20 decimals
   */
  async getERC20Decimals(tokenAddress: string): Promise<number | null> {
    try {
      const result = await this.callContractMethod(tokenAddress, ERC20_SELECTORS.decimals);
      if (result === "0x") return null;

      return parseInt(result, 16);
    } catch {
      return null;
    }
  }

  /**
   * Get ERC20 total supply
   */
  async getERC20TotalSupply(tokenAddress: string): Promise<string | null> {
    try {
      const result = await this.callContractMethod(tokenAddress, ERC20_SELECTORS.totalSupply);
      if (result === "0x") return null;

      return (BigInt(result)).toString();
    } catch {
      return null;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(address: string): Promise<string> {
    try {
      const balance = await this.call<string>("eth_getBalance", [address.toLowerCase(), "latest"]);
      return (BigInt(balance || "0")).toString();
    } catch (error) {
      throw new Error(`Failed to get balance: ${error}`);
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    try {
      const blockNum = await this.call<string>("eth_blockNumber", []);
      return parseInt(blockNum || "0", 16);
    } catch (error) {
      throw new Error(`Failed to get block number: ${error}`);
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<{
    hash: string;
    from: string;
    to: string;
    value: string;
    gasPrice: string;
  } | null> {
    try {
      return await this.call<{
        hash: string;
        from: string;
        to: string;
        value: string;
        gasPrice: string;
      } | null>("eth_getTransactionByHash", [txHash]);
    } catch {
      return null;
    }
  }

  /**
   * Detect token standard using function selectors
   */
  async detectTokenStandard(tokenAddress: string): Promise<ContractFunctionSignatures> {
    try {
      const bytecode = await this.getBytecode(tokenAddress);

      if (!bytecode.isContract) {
        return {
          hasERC20: false,
          hasERC721: false,
          hasERC1155: false,
          selectors: []
        };
      }

      const hex = bytecode.bytecode.toLowerCase();
      const selectors: string[] = [];

      // Extract function selectors from bytecode
      for (const [key, selector] of Object.entries(ERC20_SELECTORS)) {
        if (hex.includes(selector.toLowerCase())) {
          selectors.push(selector);
        }
      }

      const erc20Matches = Object.values(ERC20_SELECTORS).filter(s =>
        selectors.includes(s.toLowerCase())
      ).length;

      const erc721Matches = Object.values(ERC721_SELECTORS).filter(s =>
        hex.includes(s.toLowerCase())
      ).length;

      const erc1155Matches = Object.values(ERC1155_SELECTORS).filter(s =>
        hex.includes(s.toLowerCase())
      ).length;

      return {
        hasERC20: erc20Matches >= 6,
        hasERC721: erc721Matches >= 5,
        hasERC1155: erc1155Matches >= 4,
        selectors
      };
    } catch {
      return {
        hasERC20: false,
        hasERC721: false,
        hasERC1155: false,
        selectors: []
      };
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create RPC client
 */
export function createRPCClient(
  chainId: number = 1,
  rpcUrl?: string,
  timeout: number = 30000
): RPCClient {
  const url = rpcUrl || RPC_ENDPOINTS[chainId];

  if (!url) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  return new RPCClient({
    rpcUrl: url,
    chainId,
    timeout
  });
}

/**
 * Get RPC URL for chain
 */
export function getRPCUrl(chainId: number): string | null {
  return RPC_ENDPOINTS[chainId] || null;
}

/**
 * Get supported RPC chains
 */
export function getSupportedRPCChains(): Record<number, string> {
  return RPC_ENDPOINTS;
}

export default {
  RPCClient,
  createRPCClient,
  getRPCUrl,
  getSupportedRPCChains,
  ERC20_SELECTORS,
  ERC721_SELECTORS,
  ERC1155_SELECTORS
};
