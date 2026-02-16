/**
 * Main Workflow Entry Point - Complete Token Verification System
 *
 * Integrated Cross-chain transaction automation workflow
 * - Cron Trigger: Fetches real-time gas prices from Etherscan
 * - HTTP Trigger: Token verification with security analysis
 *
 * CRE Best Practices:
 * - Stateless operation
 * - Deterministic results
 * - Comprehensive error handling
 * - JSON-serializable responses
 */

import {
  cre,
  ConsensusAggregationByFields,
  median,
  Runner,
  type Runtime,
  type HTTPPayload,
  decodeJson
} from "@chainlink/cre-sdk";
import {
  fetchGasPrices,
  type Config,
  type GasPriceData
} from "./fetchInfo";
import { createVerificationEngine, generateVerificationReport } from "./verificationEngine";

// ============================================================================
// Types & Configuration
// ============================================================================

interface WorkflowConfig extends Config {
  // Gas price config
  schedule: string;

  // Token verification config
  etherscanApiKey: string;
  enableTokenVerification: boolean;
  defaultChainId: number;
  enableCrossChain: boolean;
  chainIds?: number[];
}

interface VerificationRequestPayload {
  tokenAddress: string;
  chainId?: number;
  crossChain?: boolean;
  format?: "json" | "report" | "summary";
}

interface VerificationResponse {
  success: boolean;
  requestId: string;
  timestamp: string;
  data?: any;
  error?: string;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Format verification result for user display
 */
function formatVerificationForUser(analysis: any, format: string = "summary"): string {
  if (format === "json") {
    return JSON.stringify(analysis, null, 2);
  }

  if (format === "report") {
    return generateVerificationReport(analysis);
  }

  // Default: summary format
  const decision = analysis.decision;
  const status = decision.isSafe ? "✅ SAFE" : "❌ UNSAFE";
  const automation = decision.canAutomate ? "✅ YES" : "❌ NO";

  const lines = [
    "═══════════════════════════════════════",
    "TOKEN VERIFICATION RESULT",
    "═══════════════════════════════════════",
    "",
    `Token Address: ${analysis.request.tokenAddress}`,
    `Status: ${status}`,
    `Risk Level: ${analysis.chainAnalysis?.riskLevel || "UNKNOWN"}`,
    `Security Score: ${analysis.chainAnalysis?.overallScore || 0}/100`,
    `Can Automate: ${automation}`,
    `Reason: ${decision.reason}`,
    ""
  ];

  if (decision.risks.length > 0) {
    lines.push("⚠️  DETECTED RISKS:");
    decision.risks.forEach((risk: string) => {
      lines.push(`  • ${risk}`);
    });
    lines.push("");
  }

  if (analysis.chainAnalysis?.recommendations) {
    lines.push("💡 RECOMMENDATIONS:");
    analysis.chainAnalysis.recommendations.forEach((rec: string) => {
      lines.push(`  ${rec}`);
    });
    lines.push("");
  }

  lines.push("═══════════════════════════════════════");

  return lines.join("\n");
}

// ============================================================================
// HTTP Trigger Handler - Token Verification
// ============================================================================

/**
 * HTTP Trigger: Verify token security
 *
 * Request body (JSON):
 * {
 *   "tokenAddress": "0x...",
 *   "chainId": 1,
 *   "crossChain": false,
 *   "format": "summary"
 * }
 *
 * Response: JSON with verification results
 */
const onHttpVerifyToken = async (
  runtime: Runtime<WorkflowConfig>,
  payload: HTTPPayload
): Promise<string> => {
  const requestId = generateRequestId();
  const timestamp = new Date().toISOString();

  try {
    // Validate payload
    if (!payload.input || payload.input.length === 0) {
      runtime.log(`[${requestId}] ❌ Empty request payload`);
      return JSON.stringify({
        success: false,
        requestId,
        timestamp,
        error: "Empty request body"
      });
    }

    // Decode JSON from payload
    let request: VerificationRequestPayload;
    try {
      request = decodeJson(payload.input) as VerificationRequestPayload;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      runtime.log(`[${requestId}] ❌ Failed to parse JSON: ${errorMsg}`);
      return JSON.stringify({
        success: false,
        requestId,
        timestamp,
        error: `Invalid JSON: ${errorMsg}`
      });
    }

    const config = runtime.config;

    // Validate API key
    if (!config.etherscanApiKey) {
      runtime.log(`[${requestId}] ❌ Error: ETHERSCAN_API_KEY not configured`);
      return JSON.stringify({
        success: false,
        requestId,
        timestamp,
        error: "Etherscan API key not configured. Please set ETHERSCAN_API_KEY environment variable."
      });
    }

    // Validate token address
    if (!request.tokenAddress) {
      runtime.log(`[${requestId}] ❌ Error: Token address not provided`);
      return JSON.stringify({
        success: false,
        requestId,
        timestamp,
        error: "Token address is required. Please provide a valid Ethereum address (0x format)"
      });
    }

    // Normalize token address
    const tokenAddress = request.tokenAddress.toLowerCase();

    // Validate address format
    if (!/^0x[a-f0-9]{40}$/.test(tokenAddress)) {
      runtime.log(`[${requestId}] ❌ Error: Invalid token address format`);
      return JSON.stringify({
        success: false,
        requestId,
        timestamp,
        error: `Invalid token address format. Expected: 0x followed by 40 hex characters. Got: ${request.tokenAddress}`
      });
    }

    // Get verification parameters
    const chainId = request.chainId || config.defaultChainId || 1;
    const crossChain = request.crossChain || false;
    const format = request.format || "summary";

    runtime.log(`[${requestId}] 🔍 Starting verification for ${tokenAddress} on chain ${chainId}`);

    // Create verification engine
    const engine = createVerificationEngine({
      etherscanApiKey: config.etherscanApiKey,
      enableCaching: true,
      cacheExpiration: 3600000, // 1 hour
      timeout: 30000,
      chainId
    });

    // Perform verification
    let verificationResult: any;

    if (crossChain && config.chainIds) {
      runtime.log(`[${requestId}] 🌍 Performing cross-chain verification`);
      verificationResult = await engine.deepVerify(tokenAddress, config.chainIds);
    } else {
      runtime.log(`[${requestId}] ⚙️  Performing single-chain verification`);
      verificationResult = await engine.quickVerify(tokenAddress, chainId);
    }

    // Format output
    const formattedResult = formatVerificationForUser(verificationResult, format);

    // Log decision
    if (verificationResult.decision.isSafe) {
      runtime.log(`[${requestId}] ✅ Token verified as SAFE`);
    } else {
      runtime.log(`[${requestId}] ❌ Token verified as UNSAFE - Risks: ${verificationResult.decision.risks.length}`);
    }

    runtime.log(formattedResult);

    // Determine response format
    let responseData: any;

    if (format === "json") {
      responseData = verificationResult;
    } else if (format === "report") {
      responseData = {
        formatted: formattedResult,
        raw: verificationResult
      };
    } else {
      // summary format
      responseData = {
        tokenAddress: tokenAddress,
        chainId: chainId,
        isSafe: verificationResult.decision.isSafe,
        canAutomate: verificationResult.decision.canAutomate,
        riskLevel: verificationResult.chainAnalysis?.riskLevel,
        score: verificationResult.chainAnalysis?.overallScore,
        risks: verificationResult.decision.risks,
        reason: verificationResult.decision.reason,
        formatted: formattedResult
      };
    }

    return JSON.stringify({
      success: true,
      requestId,
      timestamp,
      data: responseData
    });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.log(`[${requestId}] ❌ Verification failed: ${errorMsg}`);

    return JSON.stringify({
      success: false,
      requestId,
      timestamp,
      error: `Verification failed: ${errorMsg}`
    });
  }
};

// ============================================================================
// Cron Trigger Handler - Gas Prices
// ============================================================================

/**
 * Cron Trigger: Fetch gas prices periodically
 */
const onCronTrigger = async (runtime: Runtime<WorkflowConfig>): Promise<string> => {
  try {
    const config = runtime.config;
    runtime.log(`[DEBUG_CRON] enableTokenVerification: ${config.enableTokenVerification}`);
    runtime.log(`[DEBUG_CRON] etherscanApiKey: ${config.etherscanApiKey ? '***' : 'undefined'}`); // Mask API key


    runtime.log("📊 Fetching gas prices from Etherscan...");

    // Create HTTP client for fetching gas prices
    const httpClient = new cre.capabilities.HTTPClient();

    // Set up consensus aggregation
    const aggregationConfig = ConsensusAggregationByFields<GasPriceData>({
      safeGasPrice: () => median<number>(),
      proposeGasPrice: () => median<number>(),
      fastGasPrice: () => median<number>(),
      baseFee: () => median<number>(),
      lastBlock: () => median<number>()
    });

    // Execute the HTTP request with consensus aggregation
    const requestFn = httpClient.sendRequest(
      runtime,
      fetchGasPrices,
      aggregationConfig
    );

    const response = requestFn(config);
    const gasPrices = response.result();

    // Log each parameter individually
    runtime.log("═══════════════════════════════════════");
    runtime.log("⛽ GAS PRICES REPORT");
    runtime.log("═══════════════════════════════════════");
    runtime.log(`Safe Gas Price: ${gasPrices.safeGasPrice} gwei`);
    runtime.log(`Propose Gas Price: ${gasPrices.proposeGasPrice} gwei`);
    runtime.log(`Fast Gas Price: ${gasPrices.fastGasPrice} gwei`);
    runtime.log(`Base Fee: ${gasPrices.baseFee} gwei`);
    runtime.log(`Last Block: ${gasPrices.lastBlock}`);
    runtime.log("═══════════════════════════════════════");

    return JSON.stringify(gasPrices);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.log(`❌ Gas price fetch error: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
};

// ============================================================================
// Workflow Initialization
// ============================================================================

const initWorkflow = (config: WorkflowConfig) => {
  const handlers: any[] = [];

  // Cron trigger for gas prices
  console.log("⚙️  Initializing workflow handlers...");
  console.log(`[DEBUG] enableTokenVerification: ${config.enableTokenVerification}`);
  console.log(`[DEBUG] etherscanApiKey: ${config.etherscanApiKey ? '***' : 'undefined'}`); // Mask API key

  const cron = new cre.capabilities.CronCapability();
  const cronHandler = cre.handler(
    cron.trigger({ schedule: config.schedule }),
    onCronTrigger
  );
  handlers.push(cronHandler);
  console.log("✅ Gas price Cron trigger registered");

  // HTTP trigger for token verification (if enabled)
  if (config.enableTokenVerification) {
    try {
      const httpCapability = new cre.capabilities.HTTPCapability();

      // Create HTTP trigger with optional security validation
      const httpTrigger = httpCapability.trigger({});

      // Register HTTP trigger handler
      const httpHandler = cre.handler(httpTrigger, onHttpVerifyToken);

      if (httpHandler) {
        handlers.push(httpHandler);
        console.log("✅ Token verification HTTP trigger registered");
      }
    } catch (error) {
      console.log(`ℹ️  HTTP trigger registration note: ${error instanceof Error ? error.message : error}`);
      console.log("   Gas price fetching (Cron trigger) is still active");
    }
  } else {
    console.log("⚠️  Token verification HTTP trigger disabled");
  }

  console.log("✅ Workflow initialization complete\n");

  return handlers;
};

// ============================================================================
// Export - Only main() is exported for CRE SDK WASM compatibility
// ============================================================================

/**
 * Main entry point for CRE workflow
 * Initializes all triggers and handlers
 */
export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}

// Execute main
main().catch((error: unknown) => {
  console.log("❌ Workflow failed:", error);
  process.exit(1);
});

