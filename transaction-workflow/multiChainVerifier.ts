/**
 * Multi-Chain Token Verifier Module
 *
 * Searches for and verifies tokens across multiple blockchain networks
 * Identifies token bridges, wrapped versions, and cross-chain deployments
 *
 * CRE Best Practices Implemented:
 * - Parallel chain verification
 * - Timeout management
 * - Error handling for each chain
 * - JSON-serializable results
 * - Deterministic cross-chain logic
 */

import { analyzeToken, TokenAnalysisResult } from "./tokenAnalyzer";
import { createEtherscanClient } from "./etherscanApi";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface ChainVerificationResult {
  chainId: number;
  chainName: string;
  tokenAddress: string;
  exists: boolean;
  analysis?: TokenAnalysisResult;
  error?: string;
}

export interface CrossChainTokenInfo {
  baseTokenAddress: string;
  baseChainId: number;
  chainVerifications: ChainVerificationResult[];
  tokensFound: number;
  verifiedOnChains: number;
  highRiskOnChains: number;
  mediumRiskOnChains: number;
  bridgeIndicators: string[];
  wrappedVersions: WrappedTokenInfo[];
  recommendations: string[];
  analysisTimestamp: string;
}

export interface WrappedTokenInfo {
  chain: number;
  wrappedAddress: string;
  bridgeAddress: string | null;
  wrapperName: string;
}

export interface ChainConfig {
  id: number;
  name: string;
  rpcUrl?: string;
  explorerUrl: string;
}

// ============================================================================
// Supported Chains Configuration
// ============================================================================

const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  1: {
    id: 1,
    name: "Ethereum Mainnet",
    explorerUrl: "https://etherscan.io"
  },
  56: {
    id: 56,
    name: "BSC Mainnet",
    explorerUrl: "https://bscscan.com"
  },
  137: {
    id: 137,
    name: "Polygon Mainnet",
    explorerUrl: "https://polygonscan.com"
  },
  8453: {
    id: 8453,
    name: "Base Mainnet",
    explorerUrl: "https://basescan.org"
  },
  10: {
    id: 10,
    name: "Optimism",
    explorerUrl: "https://optimistic.etherscan.io"
  },
  42161: {
    id: 42161,
    name: "Arbitrum One",
    explorerUrl: "https://arbiscan.io"
  },
  43114: {
    id: 43114,
    name: "Avalanche C-Chain",
    explorerUrl: "https://snowtrace.io"
  },
  250: {
    id: 250,
    name: "Fantom",
    explorerUrl: "https://ftmscan.com"
  }
};

// ============================================================================
// Common Wrapped Token Patterns
// ============================================================================

const WRAPPED_TOKEN_PATTERNS = {
  "W": { name: "Wrapped", indicator: "bridge" },
  "wst": { name: "Wrapped Staked", indicator: "liquid_staking" },
  "x": { name: "Cross-chain", indicator: "bridge" },
  "anyCall": { name: "Multichain (AnyCall)", indicator: "bridge" },
  "ark": { name: "Ark Bridge", indicator: "bridge" },
  "stargate": { name: "Stargate", indicator: "bridge" }
};

// ============================================================================
// Token Search & Detection
// ============================================================================

/**
 * Search for token across multiple chains
 */
export async function searchTokenAcrossChains(
  tokenAddress: string,
  chainIds: number[],
  etherscanApiKey: string,
  timeout?: number
): Promise<ChainVerificationResult[]> {
  const normalizedAddress = tokenAddress.toLowerCase();
  const results: ChainVerificationResult[] = [];

  // Search on each chain
  for (const chainId of chainIds) {
    try {
      const chainConfig = SUPPORTED_CHAINS[chainId];
      if (!chainConfig) {
        results.push({
          chainId,
          chainName: `Chain ${chainId}`,
          tokenAddress: normalizedAddress,
          exists: false,
          error: "Unsupported chain"
        });
        continue;
      }

      const etherscanClient = createEtherscanClient(etherscanApiKey, chainId, timeout);

      try {
        // Check if address has code (is a contract)
        const sourceCode = await etherscanClient.getContractSourceCode(normalizedAddress);
        const tokenInfo = await etherscanClient.getTokenInfo(normalizedAddress);

        results.push({
          chainId,
          chainName: chainConfig.name,
          tokenAddress: normalizedAddress,
          exists: sourceCode !== null && sourceCode.SourceCode !== "",
          error: undefined
        });
      } catch {
        results.push({
          chainId,
          chainName: chainConfig.name,
          tokenAddress: normalizedAddress,
          exists: false,
          error: "Could not verify"
        });
      }
    } catch (error) {
      const chainConfig = SUPPORTED_CHAINS[chainId];
      results.push({
        chainId,
        chainName: chainConfig?.name || `Chain ${chainId}`,
        tokenAddress: normalizedAddress,
        exists: false,
        error: error instanceof Error ? error.message : "Error checking chain"
      });
    }
  }

  return results;
}

/**
 * Detect wrapped token patterns in name
 */
export function detectWrappedTokenPattern(tokenName: string): WrappedTokenInfo | null {
  const lowerName = tokenName.toLowerCase();

  for (const [pattern, info] of Object.entries(WRAPPED_TOKEN_PATTERNS)) {
    if (lowerName.includes(pattern)) {
      return {
        chain: 0, // To be filled by caller
        wrappedAddress: "",
        bridgeAddress: null,
        wrapperName: info.name
      };
    }
  }

  return null;
}

// ============================================================================
// Cross-Chain Analysis
// ============================================================================

/**
 * Perform comprehensive analysis on each chain
 */
export async function analyzeTokenOnMultipleChains(
  tokenAddress: string,
  chainIds: number[],
  etherscanApiKey: string,
  timeout?: number
): Promise<ChainVerificationResult[]> {
  const normalizedAddress = tokenAddress.toLowerCase();
  const results: ChainVerificationResult[] = [];

  // Analyze each chain in parallel where possible
  const analyses = await Promise.all(
    chainIds.map(async (chainId) => {
      try {
        const chainConfig = SUPPORTED_CHAINS[chainId];
        if (!chainConfig) {
          return {
            chainId,
            chainName: `Chain ${chainId}`,
            tokenAddress: normalizedAddress,
            exists: false,
            error: "Unsupported chain"
          };
        }

        try {
          const analysis = await analyzeToken(normalizedAddress, {
            chainId,
            etherscanApiKey,
            timeout: timeout || 30000
          });

          return {
            chainId,
            chainName: chainConfig.name,
            tokenAddress: normalizedAddress,
            exists: true,
            analysis: analysis as unknown as TokenAnalysisResult
          };
        } catch {
          return {
            chainId,
            chainName: chainConfig.name,
            tokenAddress: normalizedAddress,
            exists: false
          };
        }
      } catch (error) {
        return {
          chainId,
          chainName: `Chain ${chainId}`,
          tokenAddress: normalizedAddress,
          exists: false,
          error: error instanceof Error ? error.message : "Analysis error"
        };
      }
    })
  );

  return analyses as ChainVerificationResult[];
}

// ============================================================================
// Bridge Detection
// ============================================================================

/**
 * Detect bridge characteristics and cross-chain patterns
 */
export function detectBridgePatterns(results: ChainVerificationResult[]): string[] {
  const patterns: string[] = [];

  // Check if token exists on multiple chains
  const existingChains = results.filter(r => r.exists).length;
  if (existingChains > 1) {
    patterns.push(`Token deployed on ${existingChains} chains`);
  }

  // Check for risk level consistency
  const riskLevels = results
    .filter(r => r.analysis)
    .map(r => r.analysis!.riskLevel);

  const highRiskCount = riskLevels.filter(l => l === "HIGH").length;
  const criticalCount = riskLevels.filter(l => l === "CRITICAL").length;

  if (highRiskCount > 0 || criticalCount > 0) {
    patterns.push(`High risk on ${highRiskCount + criticalCount} chains`);
  }

  // Check for verified status variation
  const verifiedCount = results
    .filter(r => r.analysis && !r.analysis.riskAnalysis.unverifiedCode)
    .length;

  if (verifiedCount < existingChains && verifiedCount > 0) {
    patterns.push("Verification status varies across chains");
  }

  // Check for ownership differences
  const owners = results
    .filter(r => r.analysis)
    .map(r => r.analysis!.ownershipAnalysis.owner)
    .filter((o): o is string => o !== null);

  const uniqueOwners = new Set(owners).size;
  if (uniqueOwners > 1) {
    patterns.push(`Multiple owner addresses across chains (${uniqueOwners})`);
  }

  // Check for asset concentration
  const concentrations = results
    .filter(r => r.analysis?.holderAnalysis.isHighlyConcentrated)
    .length;

  if (concentrations > existingChains / 2) {
    patterns.push("High holder concentration across most chains");
  }

  return patterns;
}

// ============================================================================
// Cross-Chain Recommendations
// ============================================================================

/**
 * Generate cross-chain recommendations
 */
export function generateCrossChainRecommendations(analysis: CrossChainTokenInfo): string[] {
  const recommendations: string[] = [];

  if (analysis.highRiskOnChains > 0) {
    recommendations.push(`⚠️ Token rated HIGH or CRITICAL risk on ${analysis.highRiskOnChains} chain(s)`);
  }

  if (analysis.tokensFound > 4) {
    recommendations.push("⚠️ Token deployed on many chains - verify legitimacy of all versions");
  }

  if (analysis.wrappedVersions.length > 0) {
    recommendations.push(`ℹ️ Token has ${analysis.wrappedVersions.length} wrapped version(s) detected`);
  }

  if (analysis.verifiedOnChains < analysis.tokensFound) {
    const unverified = analysis.tokensFound - analysis.verifiedOnChains;
    recommendations.push(`❌ ${unverified} version(s) not verified - increased risk`);
  }

  if (analysis.verifiedOnChains === 0) {
    recommendations.push("🚫 No verified versions found - do not interact");
  }

  if (analysis.bridgeIndicators.length > 0) {
    recommendations.push("ℹ️ Potential cross-chain bridge token detected");
  }

  if (analysis.tokensFound === 0) {
    recommendations.push("ℹ️ Token not found on any network");
  } else if (analysis.tokensFound === 1) {
    recommendations.push("ℹ️ Token exists on single chain only");
  } else if (analysis.highRiskOnChains === 0 && analysis.mediumRiskOnChains <= 1) {
    recommendations.push("✅ Token appears safe on all verified chains");
  }

  return recommendations;
}

// ============================================================================
// Comprehensive Cross-Chain Analysis
// ============================================================================

/**
 * Perform comprehensive cross-chain token verification
 */
export async function verifyTokenCrossChain(
  tokenAddress: string,
  etherscanApiKey: string,
  chainIds?: number[]
): Promise<CrossChainTokenInfo> {
  try {
    const normalizedAddress = tokenAddress.toLowerCase();
    const targetChains = chainIds || Object.keys(SUPPORTED_CHAINS).map(Number);

    // Analyze token on all chains
    const chainResults = await analyzeTokenOnMultipleChains(
      normalizedAddress,
      targetChains.filter(c => SUPPORTED_CHAINS[c]),
      etherscanApiKey
    );

    // Count results
    const tokensFound = chainResults.filter(r => r.exists).length;
    const verifiedOnChains = chainResults
      .filter(r => r.analysis && !r.analysis.riskAnalysis.unverifiedCode)
      .length;

    const highRiskOnChains = chainResults
      .filter(r => r.analysis && (r.analysis.riskLevel === "HIGH" || r.analysis.riskLevel === "CRITICAL"))
      .length;

    const mediumRiskOnChains = chainResults
      .filter(r => r.analysis && r.analysis.riskLevel === "MEDIUM")
      .length;

    // Detect patterns
    const bridgeIndicators = detectBridgePatterns(chainResults);

    // Detect wrapped versions
    const wrappedVersions: WrappedTokenInfo[] = [];
    chainResults.forEach(result => {
      if (result.analysis?.standardAnalysis.detectedType !== "Unknown") {
        const wrapped = detectWrappedTokenPattern(result.analysis?.standardAnalysis.detectedType || "");
        if (wrapped) {
          wrappedVersions.push({
            ...wrapped,
            chain: result.chainId,
            wrappedAddress: result.tokenAddress
          });
        }
      }
    });

    // Generate recommendations
    const baseAnalysis: CrossChainTokenInfo = {
      baseTokenAddress: normalizedAddress,
      baseChainId: 1,
      chainVerifications: chainResults,
      tokensFound,
      verifiedOnChains,
      highRiskOnChains,
      mediumRiskOnChains,
      bridgeIndicators,
      wrappedVersions,
      recommendations: [],
      analysisTimestamp: new Date().toISOString()
    };

    baseAnalysis.recommendations = generateCrossChainRecommendations(baseAnalysis);

    return baseAnalysis;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      baseTokenAddress: tokenAddress.toLowerCase(),
      baseChainId: 1,
      chainVerifications: [],
      tokensFound: 0,
      verifiedOnChains: 0,
      highRiskOnChains: 0,
      mediumRiskOnChains: 0,
      bridgeIndicators: [errorMsg],
      wrappedVersions: [],
      recommendations: ["Cross-chain verification failed"],
      analysisTimestamp: new Date().toISOString()
    };
  }
}

// ============================================================================
// Formatting & Reporting
// ============================================================================

/**
 * Format cross-chain verification result for display
 */
export function formatCrossChainResult(analysis: CrossChainTokenInfo): string {
  const lines = [
    "=== Cross-Chain Token Analysis ===",
    `Base Token Address: ${analysis.baseTokenAddress}`,
    `Analysis Timestamp: ${analysis.analysisTimestamp}`,
    "",
    "--- Chain Summary ---",
    `Total Chains Checked: ${analysis.chainVerifications.length}`,
    `Tokens Found: ${analysis.tokensFound}`,
    `Verified on Chains: ${analysis.verifiedOnChains}`,
    `High/Critical Risk on Chains: ${analysis.highRiskOnChains}`,
    `Medium Risk on Chains: ${analysis.mediumRiskOnChains}`,
    ""
  ];

  if (analysis.chainVerifications.length > 0) {
    lines.push("--- Per-Chain Status ---");
    analysis.chainVerifications.forEach(result => {
      const status = result.analysis
        ? `${result.analysis.riskLevel} (${result.analysis.overallScore}/100)`
        : result.exists ? "UNKNOWN" : "NOT FOUND";
      lines.push(`${result.chainName}: ${status}`);
    });
    lines.push("");
  }

  if (analysis.bridgeIndicators.length > 0) {
    lines.push("--- Bridge Indicators ---");
    analysis.bridgeIndicators.forEach(indicator => {
      lines.push(`• ${indicator}`);
    });
    lines.push("");
  }

  if (analysis.wrappedVersions.length > 0) {
    lines.push("--- Wrapped Versions ---");
    analysis.wrappedVersions.forEach(wrapped => {
      lines.push(`${wrapped.wrapperName} on Chain ${wrapped.chain}`);
    });
    lines.push("");
  }

  lines.push("--- Recommendations ---");
  analysis.recommendations.forEach(rec => {
    lines.push(`• ${rec}`);
  });

  return lines.join("\n");
}

// ============================================================================
// Export Default
// ============================================================================

export function getSupportedChains(): Record<number, ChainConfig> {
  return SUPPORTED_CHAINS;
}

export default {
  verifyTokenCrossChain,
  searchTokenAcrossChains,
  analyzeTokenOnMultipleChains,
  detectBridgePatterns,
  detectWrappedTokenPattern,
  generateCrossChainRecommendations,
  formatCrossChainResult,
  getSupportedChains
};
