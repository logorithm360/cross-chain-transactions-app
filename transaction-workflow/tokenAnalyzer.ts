/**
 * Token Analyzer Module - Advanced Token Security Analysis
 *
 * Comprehensive analysis engine combining RPC and Etherscan data
 * Orchestrates token verification, risk detection, and scoring
 *
 * CRE Best Practices Implemented:
 * - Type-safe analysis functions
 * - Timeout management
 * - Error handling for all external calls
 * - JSON-serializable results
 * - Deterministic analysis logic
 */

import { createRPCClient, RPCClient } from "./rpcClientEnhanced";
import { createEtherscanClient, EtherscanAPIClient } from "./etherscanApi";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface TokenAnalysisConfig {
  chainId: number;
  etherscanApiKey: string;
  rpcUrl?: string;
  timeout?: number;
}

export interface TokenStandardAnalysis {
  isERC20: boolean;
  isERC721: boolean;
  isERC1155: boolean;
  detectedType: string;
  functionSelectors: string[];
}

export interface OwnershipAnalysis {
  owner: string | null;
  ownerLabel: string | null;
  isMultisig: boolean;
  isProxy: boolean;
  proxyImplementation: string | null;
  ownershipRisks: string[];
}

export interface HolderDistributionAnalysis {
  totalHolders: number;
  topHolder: {
    address: string;
    percentage: number;
  } | null;
  top5HoldersCombined: number;
  top10HoldersCombined: number;
  concentrationRisks: string[];
  isHighlyConcentrated: boolean;
}

export interface RiskDetectionResult {
  hasSelfdestruct: boolean;
  hasMinting: boolean;
  isPausable: boolean;
  hasBlacklist: boolean;
  proxyPatterns: string[];
  unverifiedCode: boolean;
  risks: string[];
  riskCount: number;
}

export interface TokenAnalysisResult {
  tokenAddress: string;
  chainId: number;
  analysisTimestamp: string;
  standardAnalysis: TokenStandardAnalysis;
  ownershipAnalysis: OwnershipAnalysis;
  holderAnalysis: HolderDistributionAnalysis;
  riskAnalysis: RiskDetectionResult;
  overallScore: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  recommendations: string[];
  error?: string;
}

// ============================================================================
// Token Standards Analysis
// ============================================================================

/**
 * Analyze token standard (ERC20, ERC721, ERC1155)
 */
export async function analyzeTokenStandard(
  tokenAddress: string,
  config: TokenAnalysisConfig
): Promise<TokenStandardAnalysis> {
  try {
    const rpcClient = createRPCClient(config.chainId, config.rpcUrl, config.timeout);
    const detection = await rpcClient.detectTokenStandard(tokenAddress);

    let detectedType = "Unknown";
    if (detection.hasERC20) detectedType = "ERC20";
    else if (detection.hasERC721) detectedType = "ERC721";
    else if (detection.hasERC1155) detectedType = "ERC1155";

    return {
      isERC20: detection.hasERC20,
      isERC721: detection.hasERC721,
      isERC1155: detection.hasERC1155,
      detectedType,
      functionSelectors: detection.selectors
    };
  } catch (error) {
    return {
      isERC20: false,
      isERC721: false,
      isERC1155: false,
      detectedType: "Error",
      functionSelectors: []
    };
  }
}

// ============================================================================
// Ownership Analysis
// ============================================================================

/**
 * Analyze token ownership and proxy patterns
 */
export async function analyzeOwnership(
  tokenAddress: string,
  config: TokenAnalysisConfig
): Promise<OwnershipAnalysis> {
  try {
    const etherscanClient = createEtherscanClient(config.etherscanApiKey, config.chainId, config.timeout);

    // Get contract creation info for owner
    const creationInfo = await etherscanClient.getContractCreation(tokenAddress);
    
    if (!creationInfo) {
      return {
        owner: null,
        ownerLabel: null,
        isMultisig: false,
        isProxy: false,
        proxyImplementation: null,
        ownershipRisks: ["Unable to get contract creation info"]
      };
    }
    
    const ownerLabel = await etherscanClient.getAddressLabel(creationInfo.ContractCreator);

    const ownershipRisks: string[] = [];
    let isMultisig = false;
    let isProxy = false;
    let proxyImplementation: string | null = null;

    // Check if owner is a known multisig
    if (ownerLabel?.Label && (ownerLabel.Label.includes("Multisig") || ownerLabel.Label.includes("Safe"))) {
      isMultisig = true;
    }

    // Try to detect proxy pattern
    const rpcClient = createRPCClient(config.chainId, config.rpcUrl, config.timeout);
    const bytecode = await rpcClient.getBytecode(tokenAddress);

    // Common proxy indicators in bytecode
    if (bytecode.bytecode.includes("3d82803d3d3d3d363d3d37")) {
      isProxy = true;
      ownershipRisks.push("Uses proxy pattern (upgradeable)");
    }

    // Risk assessment
    if (!isMultisig) {
      ownershipRisks.push("Single owner address (high centralization risk)");
    }

    if (!creationInfo.ContractCreator || creationInfo.ContractCreator === "0x0000000000000000000000000000000000000000") {
      ownershipRisks.push("Unknown or null owner");
    }

    return {
      owner: creationInfo.ContractCreator,
      ownerLabel: ownerLabel?.Label || null,
      isMultisig,
      isProxy,
      proxyImplementation,
      ownershipRisks
    };
  } catch (error) {
    return {
      owner: null,
      ownerLabel: null,
      isMultisig: false,
      isProxy: false,
      proxyImplementation: null,
      ownershipRisks: ["Failed to analyze ownership"]
    };
  }
}

// ============================================================================
// Holder Distribution Analysis
// ============================================================================

/**
 * Analyze token holder distribution
 */
export async function analyzeHolderDistribution(
  tokenAddress: string,
  config: TokenAnalysisConfig
): Promise<HolderDistributionAnalysis> {
  try {
    const etherscanClient = createEtherscanClient(config.etherscanApiKey, config.chainId, config.timeout);
    const holders = await etherscanClient.getTokenHolders(tokenAddress, 10);

    if (!holders || holders.length === 0) {
      return {
        totalHolders: 0,
        topHolder: null,
        top5HoldersCombined: 0,
        top10HoldersCombined: 0,
        concentrationRisks: ["Cannot analyze holder distribution"],
        isHighlyConcentrated: false
      };
    }

    const topHolder = holders[0];
    const top5Percentage = holders.slice(0, 5).reduce((sum, h) => sum + parseFloat(h.TokenHolderPercentage), 0);
    const top10Percentage = holders.reduce((sum, h) => sum + parseFloat(h.TokenHolderPercentage), 0);

    const concentrationRisks: string[] = [];
    let isHighlyConcentrated = false;

    // Risk thresholds
    if (parseFloat(topHolder.TokenHolderPercentage) > 50) {
      concentrationRisks.push(`Top holder owns ${parseFloat(topHolder.TokenHolderPercentage).toFixed(2)}% - extreme concentration`);
      isHighlyConcentrated = true;
    } else if (parseFloat(topHolder.TokenHolderPercentage) > 30) {
      concentrationRisks.push(`Top holder owns ${parseFloat(topHolder.TokenHolderPercentage).toFixed(2)}% - high concentration`);
      isHighlyConcentrated = true;
    }

    if (top5Percentage > 80) {
      concentrationRisks.push(`Top 5 holders own ${top5Percentage.toFixed(2)}% - highly concentrated`);
      isHighlyConcentrated = true;
    }

    if (top10Percentage > 95) {
      concentrationRisks.push(`Top 10 holders own ${top10Percentage.toFixed(2)}% - effectively centralized`);
      isHighlyConcentrated = true;
    }

    return {
      totalHolders: holders.length,
      topHolder: {
        address: topHolder.TokenHolderAddress,
        percentage: parseFloat(topHolder.TokenHolderPercentage)
      },
      top5HoldersCombined: top5Percentage,
      top10HoldersCombined: top10Percentage,
      concentrationRisks,
      isHighlyConcentrated
    };
  } catch (error) {
    return {
      totalHolders: 0,
      topHolder: null,
      top5HoldersCombined: 0,
      top10HoldersCombined: 0,
      concentrationRisks: ["Failed to analyze holder distribution"],
      isHighlyConcentrated: false
    };
  }
}

// ============================================================================
// Risk Detection
// ============================================================================

/**
 * Detect security risks in token contract
 */
export async function detectSecurityRisks(
  tokenAddress: string,
  config: TokenAnalysisConfig
): Promise<RiskDetectionResult> {
  try {
    const etherscanClient = createEtherscanClient(config.etherscanApiKey, config.chainId, config.timeout);
    const rpcClient = createRPCClient(config.chainId, config.rpcUrl, config.timeout);

    const risks: string[] = [];
    let hasSelfdestruct = false;
    let hasMinting = false;
    let isPausable = false;
    let hasBlacklist = false;
    const proxyPatterns: string[] = [];

    // Get contract source code
    const sourceCode = await etherscanClient.getContractSourceCode(tokenAddress);
    const unverifiedCode = !sourceCode || sourceCode.SourceCode === "";

    if (unverifiedCode) {
      risks.push("Contract source code not verified");
    } else {
      // Detect dangerous functions in source code
      const lowerSource = sourceCode.SourceCode.toLowerCase();

      if (lowerSource.includes("selfdestruct") || lowerSource.includes("suicide")) {
        hasSelfdestruct = true;
        risks.push("Contract has selfdestruct function - can be destroyed");
      }

      if (lowerSource.includes("mint(") || lowerSource.includes("_mint")) {
        hasMinting = true;
        risks.push("Contract has minting capabilities - can create new tokens");
      }

      if (lowerSource.includes("pause") || lowerSource.includes("_pause")) {
        isPausable = true;
        risks.push("Contract has pausable functions - transfers can be frozen");
      }

      if (lowerSource.includes("blacklist") || lowerSource.includes("_blacklist")) {
        hasBlacklist = true;
        risks.push("Contract has blacklist functionality - can block addresses");
      }

      // Proxy pattern detection
      if (lowerSource.includes("proxy") || lowerSource.includes("delegatecall")) {
        proxyPatterns.push("Uses delegate call pattern");
        risks.push("Uses proxy pattern - can be upgraded by owner");
      }

      if (lowerSource.includes("upgradeable") || lowerSource.includes("uups")) {
        proxyPatterns.push("UUPS proxy detected");
        risks.push("UUPS proxy pattern - upgradeable contract");
      }
    }

    // Get bytecode for additional checks
    const bytecode = await rpcClient.getBytecode(tokenAddress);
    if (bytecode.bytecode.includes("fe")) {
      // REVERT opcode presence might indicate custom error handling
    }

    return {
      hasSelfdestruct,
      hasMinting,
      isPausable,
      hasBlacklist,
      proxyPatterns,
      unverifiedCode,
      risks,
      riskCount: risks.length
    };
  } catch (error) {
    return {
      hasSelfdestruct: false,
      hasMinting: false,
      isPausable: false,
      hasBlacklist: false,
      proxyPatterns: [],
      unverifiedCode: true,
      risks: ["Failed to detect security risks"],
      riskCount: 1
    };
  }
}

// ============================================================================
// Risk Scoring
// ============================================================================

/**
 * Calculate overall token risk score (0-100, where 100 is most secure)
 */
export function scoreTokenRisk(analysis: TokenAnalysisResult): number {
  let score = 100;

  // Ownership risks (-10 to -30)
  score -= analysis.ownershipAnalysis.ownershipRisks.length * 5;
  if (analysis.ownershipAnalysis.isMultisig) score += 10; // Bonus for multisig
  if (analysis.ownershipAnalysis.isProxy) score -= 15;

  // Holder concentration risks (-15 to -40)
  if (analysis.holderAnalysis.isHighlyConcentrated) {
    score -= 20;
  }
  if (analysis.holderAnalysis.concentrationRisks.length > 2) {
    score -= 10;
  }

  // Security risks (-50 total, divided by risk type)
  if (analysis.riskAnalysis.unverifiedCode) score -= 20;
  if (analysis.riskAnalysis.hasSelfdestruct) score -= 15;
  if (analysis.riskAnalysis.hasMinting) score -= 10;
  if (analysis.riskAnalysis.isPausable) score -= 10;
  if (analysis.riskAnalysis.hasBlacklist) score -= 10;
  if (analysis.riskAnalysis.proxyPatterns.length > 0) score -= 5;

  // Total risk count penalty
  score -= Math.min(analysis.riskAnalysis.riskCount * 2, 30);

  // Bonus for ERC20 standard detection
  if (analysis.standardAnalysis.isERC20) score += 5;

  // Ensure score is in range [0, 100]
  return Math.max(0, Math.min(100, score));
}

/**
 * Determine risk level from score
 */
export function getRiskLevel(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 80) return "LOW";
  if (score >= 60) return "MEDIUM";
  if (score >= 40) return "HIGH";
  return "CRITICAL";
}

// ============================================================================
// Recommendations
// ============================================================================

/**
 * Generate security recommendations
 */
export function generateRecommendations(analysis: TokenAnalysisResult): string[] {
  const recommendations: string[] = [];

  if (analysis.riskAnalysis.unverifiedCode) {
    recommendations.push("❌ Do not interact - contract source is not verified");
  }

  if (analysis.riskAnalysis.hasSelfdestruct) {
    recommendations.push("⚠️ High risk - contract can be destroyed by owner");
  }

  if (analysis.riskAnalysis.hasBlacklist) {
    recommendations.push("⚠️ Medium risk - your address can be blacklisted");
  }

  if (analysis.riskAnalysis.hasMinting) {
    recommendations.push("⚠️ Inflation risk - owner can mint unlimited tokens");
  }

  if (analysis.holderAnalysis.isHighlyConcentrated) {
    recommendations.push("⚠️ Liquidity risk - token is highly concentrated among few holders");
  }

  if (analysis.ownershipAnalysis.isProxy && !analysis.ownershipAnalysis.isMultisig) {
    recommendations.push("⚠️ Single owner can upgrade contract at any time");
  }

  if (analysis.riskLevel === "LOW") {
    recommendations.push("✅ This token appears to be safe for interaction");
  }

  if (analysis.riskLevel === "MEDIUM") {
    recommendations.push("⚠️ Proceed with caution - manual review recommended");
  }

  if (analysis.riskLevel === "HIGH") {
    recommendations.push("❌ Not recommended for automated transactions - manual approval required");
  }

  if (analysis.riskLevel === "CRITICAL") {
    recommendations.push("🚫 Do not interact - this token has critical security issues");
  }

  return recommendations.length > 0 ? recommendations : ["No specific recommendations"];
}

// ============================================================================
// Comprehensive Analysis Orchestration
// ============================================================================

/**
 * Perform comprehensive token analysis
 * Orchestrates all analysis functions into single result
 */
export async function analyzeToken(
  tokenAddress: string,
  config: TokenAnalysisConfig
): Promise<TokenAnalysisResult> {
  try {
    const normalizedAddress = tokenAddress.toLowerCase();

    // Perform all analyses in parallel
    const [standard, ownership, holders, risks] = await Promise.all([
      analyzeTokenStandard(normalizedAddress, config),
      analyzeOwnership(normalizedAddress, config),
      analyzeHolderDistribution(normalizedAddress, config),
      detectSecurityRisks(normalizedAddress, config)
    ]);

    // Compile results
    const result: TokenAnalysisResult = {
      tokenAddress: normalizedAddress,
      chainId: config.chainId,
      analysisTimestamp: new Date().toISOString(),
      standardAnalysis: standard,
      ownershipAnalysis: ownership,
      holderAnalysis: holders,
      riskAnalysis: risks,
      overallScore: 0,
      riskLevel: "LOW",
      recommendations: []
    };

    // Calculate scoring
    result.overallScore = scoreTokenRisk(result);
    result.riskLevel = getRiskLevel(result.overallScore);
    result.recommendations = generateRecommendations(result);

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      tokenAddress: tokenAddress.toLowerCase(),
      chainId: config.chainId,
      analysisTimestamp: new Date().toISOString(),
      standardAnalysis: {
        isERC20: false,
        isERC721: false,
        isERC1155: false,
        detectedType: "Error",
        functionSelectors: []
      },
      ownershipAnalysis: {
        owner: null,
        ownerLabel: null,
        isMultisig: false,
        isProxy: false,
        proxyImplementation: null,
        ownershipRisks: ["Analysis failed"]
      },
      holderAnalysis: {
        totalHolders: 0,
        topHolder: null,
        top5HoldersCombined: 0,
        top10HoldersCombined: 0,
        concentrationRisks: ["Analysis failed"],
        isHighlyConcentrated: false
      },
      riskAnalysis: {
        hasSelfdestruct: false,
        hasMinting: false,
        isPausable: false,
        hasBlacklist: false,
        proxyPatterns: [],
        unverifiedCode: true,
        risks: [errorMsg],
        riskCount: 1
      },
      overallScore: 0,
      riskLevel: "CRITICAL",
      recommendations: ["Analysis failed - cannot determine if token is safe"],
      error: errorMsg
    };
  }
}

// ============================================================================
// Batch Analysis
// ============================================================================

/**
 * Analyze multiple tokens in parallel
 */
export async function analyzeTokenBatch(
  tokenAddresses: string[],
  config: TokenAnalysisConfig
): Promise<TokenAnalysisResult[]> {
  const results = await Promise.all(
    tokenAddresses.map(address => analyzeToken(address, config))
  );
  return results;
}

// ============================================================================
// Formatting & Reporting
// ============================================================================

/**
 * Format analysis result for display
 */
export function formatAnalysisResult(analysis: TokenAnalysisResult): string {
  const lines = [
    "=== Token Analysis Report ===",
    `Token Address: ${analysis.tokenAddress}`,
    `Chain ID: ${analysis.chainId}`,
    `Timestamp: ${analysis.analysisTimestamp}`,
    "",
    "--- Token Standard ---",
    `Type: ${analysis.standardAnalysis.detectedType}`,
    `ERC20: ${analysis.standardAnalysis.isERC20}`,
    `ERC721: ${analysis.standardAnalysis.isERC721}`,
    `ERC1155: ${analysis.standardAnalysis.isERC1155}`,
    "",
    "--- Ownership ---",
    `Owner: ${analysis.ownershipAnalysis.owner || "Unknown"}`,
    `Multisig: ${analysis.ownershipAnalysis.isMultisig}`,
    `Proxy: ${analysis.ownershipAnalysis.isProxy}`,
    `Risks: ${analysis.ownershipAnalysis.ownershipRisks.length}`,
    "",
    "--- Holder Distribution ---",
    `Total Holders: ${analysis.holderAnalysis.totalHolders}`,
    `Top Holder %: ${analysis.holderAnalysis.topHolder?.percentage.toFixed(2) || "N/A"}%`,
    `Top 5 Combined: ${analysis.holderAnalysis.top5HoldersCombined.toFixed(2)}%`,
    `Concentration Risk: ${analysis.holderAnalysis.isHighlyConcentrated ? "YES" : "NO"}`,
    "",
    "--- Security Risks ---",
    `Verified: ${analysis.riskAnalysis.unverifiedCode ? "NO" : "YES"}`,
    `Selfdestruct: ${analysis.riskAnalysis.hasSelfdestruct}`,
    `Minting: ${analysis.riskAnalysis.hasMinting}`,
    `Pausable: ${analysis.riskAnalysis.isPausable}`,
    `Blacklist: ${analysis.riskAnalysis.hasBlacklist}`,
    `Total Risks: ${analysis.riskAnalysis.riskCount}`,
    "",
    "--- Overall Assessment ---",
    `Security Score: ${analysis.overallScore}/100`,
    `Risk Level: ${analysis.riskLevel}`,
    "",
    "--- Recommendations ---",
    ...analysis.recommendations
  ];

  return lines.join("\n");
}

// ============================================================================
// Export Default
// ============================================================================

export default {
  analyzeToken,
  analyzeTokenBatch,
  analyzeTokenStandard,
  analyzeOwnership,
  analyzeHolderDistribution,
  detectSecurityRisks,
  scoreTokenRisk,
  getRiskLevel,
  generateRecommendations,
  formatAnalysisResult
};
