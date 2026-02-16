/**
 * Token Verification Integration Example
 *
 * Demonstrates how to use the verification engine in various scenarios
 * Can be integrated into HTTP handlers, CLI tools, or external applications
 *
 * CRE Best Practices:
 * - Stateless operation
 * - Deterministic results
 * - Comprehensive error handling
 * - JSON-serializable responses
 */

import { createVerificationEngine, generateVerificationReport, compareVerifications } from "./verificationEngine";
import { createRPCClient } from "./rpcClientEnhanced";
import { createEtherscanClient } from "./etherscanApi";

// ============================================================================
// Configuration
// ============================================================================

const VERIFICATION_CONFIG = {
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || "",
  enableCaching: true,
  cacheExpiration: 3600000, // 1 hour
  timeout: 30000, // 30 seconds
  chainId: 1 // Ethereum Mainnet
};

// ============================================================================
// Standalone Verification Functions (Can be called from HTTP handlers)
// ============================================================================

/**
 * Verify a single token and return structured result
 * Can be called from HTTP POST /verify-token
 */
export async function verifyTokenRequest(
  tokenAddress: string,
  chainId: number = 1,
  crossChain: boolean = false,
  chainIds?: number[]
): Promise<{
  success: boolean;
  data?: any;
  error?: string;
}> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    if (crossChain && chainIds) {
      const result = await engine.verify({
        tokenAddress,
        chainId,
        crossChainVerification: true,
        chainIds
      });
      return { success: true, data: result };
    } else {
      const result = await engine.quickVerify(tokenAddress, chainId);
      return { success: true, data: result };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Batch verify multiple tokens
 * Can be called from HTTP POST /verify-tokens-batch
 */
export async function verifyTokensBatch(
  tokenAddresses: string[],
  chainId: number = 1
): Promise<{
  success: boolean;
  data?: any;
  error?: string;
}> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    const requests = tokenAddresses.map(address => ({
      tokenAddress: address,
      chainId,
      crossChainVerification: false
    }));

    const results = await engine.verifyBatch(requests);

    return {
      success: true,
      data: {
        total: results.length,
        safe: results.filter(r => r.decision.isSafe).length,
        unsafe: results.filter(r => !r.decision.isSafe).length,
        results: results.map(r => ({
          address: r.request.tokenAddress,
          isSafe: r.decision.isSafe,
          canAutomate: r.decision.canAutomate,
          riskLevel: r.chainAnalysis?.riskLevel,
          score: r.chainAnalysis?.overallScore,
          reason: r.decision.reason
        }))
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Get human-readable verification report
 * Can be called from HTTP GET /verify-token/{address}/report
 */
export async function getVerificationReport(
  tokenAddress: string,
  chainId: number = 1
): Promise<string> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    const result = await engine.quickVerify(tokenAddress, chainId);
    return generateVerificationReport(result);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Quick safety check - return only yes/no decision
 * Can be called from HTTP GET /is-token-safe/{address}
 */
export async function isTokenSafe(
  tokenAddress: string,
  chainId: number = 1
): Promise<{
  safe: boolean;
  canAutomate: boolean;
  reason: string;
}> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    const result = await engine.quickVerify(tokenAddress, chainId);

    return {
      safe: result.decision.isSafe,
      canAutomate: result.decision.canAutomate,
      reason: result.decision.reason
    };
  } catch (error) {
    return {
      safe: false,
      canAutomate: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Get only detected risks
 * Can be called from HTTP GET /token-risks/{address}
 */
export async function getTokenRisks(
  tokenAddress: string,
  chainId: number = 1
): Promise<{
  riskCount: number;
  risks: string[];
  riskLevel: string;
}> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    const result = await engine.quickVerify(tokenAddress, chainId);

    return {
      riskCount: result.decision.risks.length,
      risks: result.decision.risks,
      riskLevel: result.chainAnalysis?.riskLevel || "UNKNOWN"
    };
  } catch (error) {
    return {
      riskCount: 1,
      risks: [error instanceof Error ? error.message : String(error)],
      riskLevel: "ERROR"
    };
  }
}

/**
 * Compare multiple tokens and return comparison matrix
 * Can be called from HTTP POST /compare-tokens
 */
export async function compareTokens(
  tokenAddresses: string[],
  chainId: number = 1
): Promise<{
  success: boolean;
  comparison?: string;
  error?: string;
}> {
  try {
    const engine = createVerificationEngine({
      ...VERIFICATION_CONFIG,
      chainId
    });

    const requests = tokenAddresses.map(address => ({
      tokenAddress: address,
      chainId
    }));

    const results = await engine.verifyBatch(requests);
    const comparison = compareVerifications(results);

    return {
      success: true,
      comparison
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

// ============================================================================
// Direct RPC Queries (Advanced)
// ============================================================================

/**
 * Get token metadata directly via RPC
 * Useful when Etherscan is unavailable
 */
export async function getTokenMetadataViaRPC(
  tokenAddress: string,
  chainId: number = 1
): Promise<{
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  error?: string;
}> {
  try {
    const rpcClient = createRPCClient(chainId);

    const [name, symbol, decimals, totalSupply] = await Promise.all([
      rpcClient.getERC20Name(tokenAddress),
      rpcClient.getERC20Symbol(tokenAddress),
      rpcClient.getERC20Decimals(tokenAddress),
      rpcClient.getERC20TotalSupply(tokenAddress)
    ]);

    return {
      name,
      symbol,
      decimals,
      totalSupply
    };
  } catch (error) {
    return {
      name: null,
      symbol: null,
      decimals: null,
      totalSupply: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Get token standard (ERC20, ERC721, ERC1155)
 * Useful for determining token type
 */
export async function getTokenStandard(
  tokenAddress: string,
  chainId: number = 1
): Promise<{
  standard: string;
  isERC20: boolean;
  isERC721: boolean;
  isERC1155: boolean;
}> {
  try {
    const rpcClient = createRPCClient(chainId);
    const detection = await rpcClient.detectTokenStandard(tokenAddress);

    let standard = "Unknown";
    if (detection.hasERC20) standard = "ERC20";
    else if (detection.hasERC721) standard = "ERC721";
    else if (detection.hasERC1155) standard = "ERC1155";

    return {
      standard,
      isERC20: detection.hasERC20,
      isERC721: detection.hasERC721,
      isERC1155: detection.hasERC1155
    };
  } catch (error) {
    return {
      standard: "Error",
      isERC20: false,
      isERC721: false,
      isERC1155: false
    };
  }
}

// ============================================================================
// CLI Interface Functions
// ============================================================================

/**
 * Format result for CLI output
 */
export async function cliVerifyToken(tokenAddress: string): Promise<void> {
  console.log(`\n📋 Verifying token: ${tokenAddress}`);
  console.log("⏳ Please wait...\n");

  const result = await verifyTokenRequest(tokenAddress);

  if (!result.success) {
    console.error(`❌ Error: ${result.error}`);
    return;
  }

  const data = result.data;
  console.log(`✅ Verification Complete\n`);
  console.log(`Status: ${data.decision.isSafe ? "✅ SAFE" : "❌ UNSAFE"}`);
  console.log(`Risk Level: ${data.chainAnalysis?.riskLevel}`);
  console.log(`Score: ${data.chainAnalysis?.overallScore}/100`);
  console.log(`Risks: ${data.decision.risks.length} detected`);

  if (data.decision.risks.length > 0) {
    console.log("\n🔍 Identified Risks:");
    data.decision.risks.forEach((risk: string) => {
      console.log(`  • ${risk}`);
    });
  }

  console.log(`\n💬 Recommendation: ${data.decision.reason}`);
}

// ============================================================================
// Integration Example for HTTP Handler
// ============================================================================

/**
 * Example: Express HTTP handler
 *
 * Usage:
 * app.post("/api/verify-token", async (req, res) => {
 *   const result = await verifyTokenRequest(
 *     req.body.tokenAddress,
 *     req.body.chainId || 1
 *   );
 *   res.json(result);
 * });
 */

/**
 * Example: Express batch handler
 *
 * Usage:
 * app.post("/api/verify-tokens", async (req, res) => {
 *   const result = await verifyTokensBatch(
 *     req.body.tokenAddresses,
 *     req.body.chainId || 1
 *   );
 *   res.json(result);
 * });
 */

// ============================================================================
// Export Default
// ============================================================================

export default {
  // Main verification functions
  verifyTokenRequest,
  verifyTokensBatch,
  getVerificationReport,

  // Quick checks
  isTokenSafe,
  getTokenRisks,
  compareTokens,

  // RPC queries
  getTokenMetadataViaRPC,
  getTokenStandard,

  // CLI
  cliVerifyToken,

  // Configuration
  VERIFICATION_CONFIG
};
