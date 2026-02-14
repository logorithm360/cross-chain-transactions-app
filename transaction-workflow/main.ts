/**
 * Main Workflow Entry Point
 *
 * Cross-chain transaction automation workflow
 * Fetches and returns real-time gas prices from Etherscan
 */

import {
  cre,
  ConsensusAggregationByFields,
  median,
  Runner,
  type Runtime
} from "@chainlink/cre-sdk";
import {
  fetchGasPrices,
  type Config,
  type GasPriceData
} from "./fetchInfo";

// ============================================================================
// Configuration
// ============================================================================

interface WorkflowConfig extends Config {
  enableTokenSecurityCheck: boolean;
  requiredRiskLevel: string;
  minSecurityScore: number;
  trustedTokens?: string[];
  blockedTokens?: string[];
  etherscanApiKey: string;
  schedule: string;
}

// ============================================================================
// Main Workflow Handlers
// ============================================================================

const onCronTrigger = async (runtime: Runtime<WorkflowConfig>): Promise<string> => {
  try {
    const config = runtime.config;

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
    runtime.log("=== Gas Prices Report ===");
    runtime.log(`Safe Gas Price: ${gasPrices.safeGasPrice}`);
    runtime.log(`Propose Gas Price: ${gasPrices.proposeGasPrice}`);
    runtime.log(`Fast Gas Price: ${gasPrices.fastGasPrice}`);
    runtime.log(`Base Fee: ${gasPrices.baseFee}`);
    runtime.log(`Last Block: ${gasPrices.lastBlock}`);

    // Return raw data as JSON
    return JSON.stringify(gasPrices);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.log(`Error: ${errorMsg}`);
    return JSON.stringify({ error: errorMsg });
  }
};

const initWorkflow = (config: WorkflowConfig) => {
  const cron = new cre.capabilities.CronCapability();
  return [
    cre.handler(
      cron.trigger({ schedule: config.schedule }),
      onCronTrigger
    )
  ];
};

// ============================================================================
// Export - Only main() is exported for CRE SDK WASM compatibility
// ============================================================================

export async function main() {
  const runner = await Runner.newRunner<WorkflowConfig>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("Workflow failed:", error);
  process.exit(1);
});
