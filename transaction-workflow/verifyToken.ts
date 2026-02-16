/**
 * Token Verification Module
 *
 * Comprehensive token security verification system
 * Checks token validity, security, and returns detailed verification results
 */

import {
  performSecurityCheck,
  validateAddressFormat
} from "./tokenSecutiryCheck";
import {
  createEtherscanClient,
  CHAIN_CONFIGS
} from "./etherscan";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface TokenVerificationRequest {
  tokenAddress: string;
  chainId?: number;
}

export interface TokenVerificationResult {
  success: boolean;
  tokenAddress: string;
  chain: {
    id: number;
    name: string;
  };
  verification: {
    isValid: boolean;
    isVerified: boolean;
    isContract: boolean;
    contractStatus: string;
  };
  security: {
    riskLevel: string;
    score: number;
    vulnerabilities: string[];
  };
  metadata?: {
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    tokenType: string | null;
  };
  error?: string;
  timestamp: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get chain name from chain ID
 */
export function getChainName(chainId: number): string {
  const config = CHAIN_CONFIGS[chainId];
  return config?.name || `Unknown Chain ${chainId}`;
}

/**
 * Format verification result as concise parameter list
 */
export function formatVerificationResult(result: TokenVerificationResult): string {
  if (!result.success) {
    return `Token Verification Failed\nAddress: ${result.tokenAddress}\nChain: ${result.chain.name}\nError: ${result.error}`;
  }

  const lines = [
    "=== Token Verification Report ===",
    `Token Address: ${result.tokenAddress}`,
    `Chain: ${result.chain.name} (${result.chain.id})`,
    `Valid Address: ${result.verification.isValid}`,
    `Is Contract: ${result.verification.isContract}`,
    `Verified on Explorer: ${result.verification.isVerified}`,
    `Contract Status: ${result.verification.contractStatus}`,
    `Risk Level: ${result.security.riskLevel}`,
    `Security Score: ${result.security.score}/100`,
    `Vulnerabilities: ${result.security.vulnerabilities.length}`,
    ...(result.metadata
      ? [
          `Token Name: ${result.metadata.name || "Unknown"}`,
          `Token Symbol: ${result.metadata.symbol || "Unknown"}`,
          `Token Type: ${result.metadata.tokenType || "Unknown"}`,
          `Decimals: ${result.metadata.decimals ?? "Unknown"}`
        ]
      : []),
    `Timestamp: ${result.timestamp}`
  ];

  return lines.join("\n");
}

// ============================================================================
// Main Verification Function
// ============================================================================

/**
 * Verify token across supported chains
 * Returns comprehensive verification results including security analysis
 */
export async function verifyToken(
  tokenAddress: string,
  chainId: number = 1,
  etherscanApiKey: string
): Promise<TokenVerificationResult> {
  try {
    // Validate address format
    const addressValidation = validateAddressFormat(tokenAddress);
    if (!addressValidation.isValid) {
      return {
        success: false,
        tokenAddress,
        chain: { id: chainId, name: getChainName(chainId) },
        verification: {
          isValid: false,
          isVerified: false,
          isContract: false,
          contractStatus: "Invalid Address"
        },
        security: {
          riskLevel: "CRITICAL",
          score: 0,
          vulnerabilities: addressValidation.errors
        },
        error: addressValidation.errors.join("; "),
        timestamp: new Date().toISOString()
      };
    }

    const normalizedAddress = tokenAddress.toLowerCase();

    // Perform security check
    const securityResult = await performSecurityCheck(
      { address: normalizedAddress, chainId },
      {
        apiKeys: { etherscan: etherscanApiKey },
        chainId,
        enableExternalApiCalls: true
      }
    );

    // Get token info from Etherscan
    const etherscanClient = createEtherscanClient(etherscanApiKey, chainId);
    const isVerified = await etherscanClient.isVerified(normalizedAddress);
    const tokenInfo = await etherscanClient.getTokenInfo(normalizedAddress);

    return {
      success: true,
      tokenAddress: normalizedAddress,
      chain: {
        id: chainId,
        name: getChainName(chainId)
      },
      verification: {
        isValid: securityResult.isContract,
        isVerified,
        isContract: securityResult.isContract,
        contractStatus: securityResult.contractStatus
      },
      security: {
        riskLevel: securityResult.riskLevel,
        score: securityResult.overallScore,
        vulnerabilities: securityResult.vulnerabilities.map(v => `${v.type}: ${v.description}`)
      },
      metadata: {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        tokenType: tokenInfo.tokenType
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      tokenAddress,
      chain: { id: chainId, name: getChainName(chainId) },
      verification: {
        isValid: false,
        isVerified: false,
        isContract: false,
        contractStatus: "Error"
      },
      security: {
        riskLevel: "UNKNOWN",
        score: 0,
        vulnerabilities: []
      },
      error: errorMsg,
      timestamp: new Date().toISOString()
    };
  }
}

// ============================================================================
// Batch Verification
// ============================================================================

/**
 * Verify multiple tokens in parallel
 */
export async function verifyTokenBatch(
  tokenAddresses: string[],
  chainId: number = 1,
  etherscanApiKey: string
): Promise<TokenVerificationResult[]> {
  const results = await Promise.all(
    tokenAddresses.map(address => verifyToken(address, chainId, etherscanApiKey))
  );
  return results;
}

export default {
  verifyToken,
  verifyTokenBatch,
  formatVerificationResult,
  getChainName
};
