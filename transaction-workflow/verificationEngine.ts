/**
 * Verification Engine - Unified Token Verification Orchestrator
 *
 * Combines all verification modules (analyzer, multi-chain, RPC, Etherscan)
 * Provides comprehensive single-entry-point verification with caching
 *
 * CRE Best Practices Implemented:
 * - Unified verification interface
 * - Result caching for performance
 * - Timeout management
 * - Error handling and recovery
 * - JSON-serializable results
 * - Deterministic verification logic
 */

import { analyzeToken, TokenAnalysisResult, formatAnalysisResult } from "./tokenAnalyzer";
import { verifyTokenCrossChain, CrossChainTokenInfo, formatCrossChainResult } from "./multiChainVerifier";
import { createEtherscanClient } from "./etherscanApi";
import { createRPCClient } from "./rpcClientEnhanced";

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface VerificationEngineConfig {
  etherscanApiKey: string;
  enableCaching?: boolean;
  cacheExpiration?: number; // milliseconds
  timeout?: number; // milliseconds
  chainId?: number; // default chain for single-chain verification
}

export interface VerificationRequest {
  tokenAddress: string;
  chainId?: number;
  crossChainVerification?: boolean;
  chainIds?: number[];
}

export interface VerificationDecision {
  isSafe: boolean;
  canAutomate: boolean;
  requiresApproval: boolean;
  risks: string[];
  reason: string;
}

export interface VerificationEngineResult {
  requestId: string;
  timestamp: string;
  request: VerificationRequest;
  chainAnalysis?: TokenAnalysisResult;
  crossChainAnalysis?: CrossChainTokenInfo;
  decision: VerificationDecision;
  formattedReport: string;
}

export interface CachedResult {
  result: VerificationEngineResult;
  timestamp: number;
}

// ============================================================================
// Decision Rules
// ============================================================================

/**
 * Make verification decision based on analysis
 */
export function makeVerificationDecision(
  analysis: TokenAnalysisResult,
  crossChainAnalysis?: CrossChainTokenInfo
): VerificationDecision {
  const risks: string[] = [];
  let isSafe = false;  // ✅ DEFAULT TO FALSE (safer approach)
  let canAutomate = false;
  let requiresApproval = false;

  // Check if analysis failed
  if (analysis.error) {
    risks.push(`Verification Error: ${analysis.error}`);
    return {
      isSafe: false,
      canAutomate: false,
      requiresApproval: false,
      risks,
      reason: `Cannot verify token: ${analysis.error}`
    };
  }

  // Evaluate primary chain analysis
  if (analysis.riskLevel === "CRITICAL") {
    risks.push("Token rated CRITICAL risk");
    isSafe = false;
  } else if (analysis.riskLevel === "HIGH") {
    risks.push("Token rated HIGH risk");
    isSafe = false;
    requiresApproval = true;
  } else if (analysis.riskLevel === "MEDIUM") {
    risks.push("Token rated MEDIUM risk");
    isSafe = false;  // ✅ MEDIUM is also NOT SAFE by default
    requiresApproval = true;
  } else if (analysis.riskLevel === "LOW") {
    isSafe = true;
    canAutomate = true;
  } else {
    // Unknown risk level - default to unsafe
    risks.push(`Unknown risk level: ${analysis.riskLevel}`);
    isSafe = false;
  }

  // Add specific risks
  risks.push(...analysis.riskAnalysis.risks);

  // Evaluate cross-chain if available
  if (crossChainAnalysis) {
    if (crossChainAnalysis.highRiskOnChains > 0) {
      risks.push(`High risk on ${crossChainAnalysis.highRiskOnChains} chain(s)`);
      isSafe = false;
    }

    if (crossChainAnalysis.tokensFound === 0) {
      risks.push("Token not found on any network");
      isSafe = false;
    } else if (crossChainAnalysis.verifiedOnChains === 0) {
      risks.push("Not verified on any chain");
      isSafe = false;
    }
  }

  // Final decision logic
  if (analysis.riskAnalysis.unverifiedCode) {
    canAutomate = false;
    if (isSafe) {
      isSafe = false;  // ✅ Unverified code makes it unsafe
      risks.push("Unverified contract source code");
    }
  }

  if (analysis.holderAnalysis.isHighlyConcentrated) {
    requiresApproval = true;
    if (isSafe) {
      isSafe = false;  // ✅ High concentration makes it unsafe by default
      risks.push("Highly concentrated token holdings");
    }
  }

  // ✅ If no specific safe indicators, default to unsafe
  if (!isSafe && !risks.includes("Token rated CRITICAL risk") &&
      !risks.includes("Token rated HIGH risk") &&
      !risks.includes("Token rated MEDIUM risk")) {
    // This shouldn't happen, but just in case
    risks.push("Unable to verify token safety with confidence");
  }

  const reason = isSafe
    ? canAutomate
      ? "Token appears safe for automated transactions"
      : "Token is safe but requires user interaction"
    : requiresApproval
      ? "Token has risks and requires approval"
      : "Token is not safe to interact with";

  return {
    isSafe,
    canAutomate,
    requiresApproval,
    risks: [...new Set(risks)], // Remove duplicates
    reason
  };
}

// ============================================================================
// Verification Engine
// ============================================================================

export class VerificationEngine {
  private config: VerificationEngineConfig;
  private cache: Map<string, CachedResult> = new Map();
  private requestCounter: number = 0;

  constructor(config: VerificationEngineConfig) {
    this.config = {
      enableCaching: true,
      cacheExpiration: 3600000, // 1 hour default
      timeout: 30000, // 30 seconds default
      chainId: 1, // Ethereum default
      ...config
    };
  }

  /**
   * Generate unique request ID
   */
  private generateRequestId(): string {
    this.requestCounter++;
    return `req_${Date.now()}_${this.requestCounter}`;
  }

  /**
   * Generate cache key
   */
  private getCacheKey(request: VerificationRequest): string {
    return `${request.tokenAddress}:${request.chainId || this.config.chainId}:${request.crossChainVerification || false}`;
  }

  /**
   * Get cached result if available and not expired
   */
  private getCachedResult(request: VerificationRequest): VerificationEngineResult | null {
    if (!this.config.enableCaching) return null;

    const cacheKey = this.getCacheKey(request);
    const cached = this.cache.get(cacheKey);

    if (!cached) return null;

    const now = Date.now();
    const age = now - cached.timestamp;

    if (age > (this.config.cacheExpiration || 3600000)) {
      this.cache.delete(cacheKey);
      return null;
    }

    return cached.result;
  }

  /**
   * Cache verification result
   */
  private cacheResult(request: VerificationRequest, result: VerificationEngineResult): void {
    if (!this.config.enableCaching) return;

    const cacheKey = this.getCacheKey(request);
    this.cache.set(cacheKey, {
      result,
      timestamp: Date.now()
    });
  }

  /**
   * Clear cache
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  public getCacheStats(): { size: number; entries: string[] } {
    return {
      size: this.cache.size,
      entries: Array.from(this.cache.keys())
    };
  }

  /**
   * Verify token with comprehensive analysis
   */
  public async verify(request: VerificationRequest): Promise<VerificationEngineResult> {
    try {
      // Check cache first
      const cached = this.getCachedResult(request);
      if (cached) {
        return { ...cached, requestId: this.generateRequestId() };
      }

      const requestId = this.generateRequestId();
      const timestamp = new Date().toISOString();
      const chainId = request.chainId || this.config.chainId || 1;

      // Perform single-chain analysis
      let chainAnalysis: TokenAnalysisResult | undefined;
      try {
        chainAnalysis = await analyzeToken(request.tokenAddress, {
          chainId,
          etherscanApiKey: this.config.etherscanApiKey,
          timeout: this.config.timeout
        });
      } catch (error) {
        // Single chain analysis might fail, continue to cross-chain if requested
        if (!request.crossChainVerification) throw error;
      }

      // Perform cross-chain analysis if requested
      let crossChainAnalysis: CrossChainTokenInfo | undefined;
      if (request.crossChainVerification) {
        try {
          crossChainAnalysis = await verifyTokenCrossChain(
            request.tokenAddress,
            this.config.etherscanApiKey,
            request.chainIds
          );
        } catch (error) {
          // Cross-chain analysis is optional
        }
      }

      // Make decision
      const decision = makeVerificationDecision(
        chainAnalysis || {
          tokenAddress: request.tokenAddress,
          chainId,
          analysisTimestamp: timestamp,
          standardAnalysis: {
            isERC20: false,
            isERC721: false,
            isERC1155: false,
            detectedType: "Unknown",
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
            risks: ["Analysis failed"],
            riskCount: 1
          },
          overallScore: 0,
          riskLevel: "CRITICAL",
          recommendations: ["Analysis failed"]
        },
        crossChainAnalysis
      );

      // Generate formatted report
      let formattedReport = "";
      if (chainAnalysis) {
        formattedReport = formatAnalysisResult(chainAnalysis);
      }
      if (crossChainAnalysis && request.crossChainVerification) {
        formattedReport += "\n\n" + formatCrossChainResult(crossChainAnalysis);
      }

      const result: VerificationEngineResult = {
        requestId,
        timestamp,
        request,
        chainAnalysis,
        crossChainAnalysis,
        decision,
        formattedReport: formattedReport || "No analysis available"
      };

      // Cache result
      this.cacheResult(request, result);

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        requestId: this.generateRequestId(),
        timestamp: new Date().toISOString(),
        request,
        decision: {
          isSafe: false,
          canAutomate: false,
          requiresApproval: false,
          risks: [errorMsg],
          reason: `Verification failed: ${errorMsg}`
        },
        formattedReport: `Error during verification: ${errorMsg}`
      };
    }
  }

  /**
   * Quick verification (single chain analysis only)
   */
  public async quickVerify(tokenAddress: string, chainId?: number): Promise<VerificationEngineResult> {
    return this.verify({
      tokenAddress,
      chainId: chainId || this.config.chainId,
      crossChainVerification: false
    });
  }

  /**
   * Deep verification (single and cross-chain analysis)
   */
  public async deepVerify(tokenAddress: string, chainIds?: number[]): Promise<VerificationEngineResult> {
    return this.verify({
      tokenAddress,
      chainId: this.config.chainId,
      crossChainVerification: true,
      chainIds
    });
  }

  /**
   * Batch verification
   */
  public async verifyBatch(
    requests: VerificationRequest[]
  ): Promise<VerificationEngineResult[]> {
    const results = await Promise.all(
      requests.map(request => this.verify(request))
    );
    return results;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create verification engine instance
 */
export function createVerificationEngine(config: VerificationEngineConfig): VerificationEngine {
  return new VerificationEngine(config);
}

// ============================================================================
// Report Generation
// ============================================================================

/**
 * Generate comprehensive verification report
 */
export function generateVerificationReport(result: VerificationEngineResult): string {
  const lines = [
    "═════════════════════════════════════════",
    "TOKEN VERIFICATION REPORT",
    "═════════════════════════════════════════",
    `Request ID: ${result.requestId}`,
    `Timestamp: ${result.timestamp}`,
    "",
    "--- Verification Decision ---",
    `Safe to Interact: ${result.decision.isSafe ? "✅ YES" : "❌ NO"}`,
    `Can Automate: ${result.decision.canAutomate ? "✅ YES" : "⚠️ NO"}`,
    `Requires Approval: ${result.decision.requiresApproval ? "⚠️ YES" : "❌ NO"}`,
    `Reason: ${result.decision.reason}`,
    ""
  ];

  if (result.decision.risks.length > 0) {
    lines.push("--- Detected Risks ---");
    result.decision.risks.forEach(risk => {
      lines.push(`• ${risk}`);
    });
    lines.push("");
  }

  lines.push("--- Detailed Analysis ---");
  lines.push(result.formattedReport);
  lines.push("");
  lines.push("═════════════════════════════════════════");

  return lines.join("\n");
}

/**
 * Generate concise verification summary
 */
export function generateVerificationSummary(result: VerificationEngineResult): string {
  const decision = result.decision;
  const status = decision.isSafe ? "✅ SAFE" : "❌ UNSAFE";
  const automation = decision.canAutomate ? "✅" : "❌";
  const riskCount = decision.risks.length;

  return [
    `Token: ${result.request.tokenAddress}`,
    `Status: ${status}`,
    `Automate: ${automation}`,
    `Risks Detected: ${riskCount}`,
    `Reason: ${decision.reason}`
  ].join("\n");
}

// ============================================================================
// Batch Utilities
// ============================================================================

/**
 * Compare multiple token verifications
 */
export function compareVerifications(results: VerificationEngineResult[]): string {
  const lines = [
    "═════════════════════════════════════════",
    "TOKEN VERIFICATION COMPARISON",
    "═════════════════════════════════════════",
    ""
  ];

  results.forEach((result, index) => {
    const status = result.decision.isSafe ? "✅" : "❌";
    const risks = result.decision.risks.length;
    lines.push(
      `${index + 1}. ${result.request.tokenAddress}`,
      `   Status: ${status}`,
      `   Risks: ${risks}`,
      `   Reason: ${result.decision.reason}`,
      ""
    );
  });

  // Summary statistics
  const safeCount = results.filter(r => r.decision.isSafe).length;
  const autoCount = results.filter(r => r.decision.canAutomate).length;

  lines.push("--- Summary ---");
  lines.push(`Total Tokens: ${results.length}`);
  lines.push(`Safe: ${safeCount}/${results.length}`);
  lines.push(`Can Automate: ${autoCount}/${results.length}`);
  lines.push("═════════════════════════════════════════");

  return lines.join("\n");
}

// ============================================================================
// Export Default
// ============================================================================

export default {
  VerificationEngine,
  createVerificationEngine,
  makeVerificationDecision,
  generateVerificationReport,
  generateVerificationSummary,
  compareVerifications
};
