/**
 * Main Workflow Entry Point - SIMPLIFIED FOR DEBUGGING
 *
 * Cross-chain transaction automation workflow with token security checks
 * NOTE: HTTPClient temporarily disabled for debugging WASM error
 */

import {
  cre,
  Runner,
  type Runtime
} from "@chainlink/cre-sdk";
import type { Config } from "./fetchInfo";

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
    runtime.log(`Cron trigger activated at ${new Date().toISOString()}`);

    const config = runtime.config;
    runtime.log(`Workflow Config:`);
    runtime.log(`  Schedule: ${config.schedule}`);
    runtime.log(`  Token Security Check: ${config.enableTokenSecurityCheck}`);
    runtime.log(`  Min Security Score: ${config.minSecurityScore}`);

    // Simple response for now
    const result = {
      status: "success",
      timestamp: new Date().toISOString(),
      configReceived: true
    };

    runtime.log(`Workflow completed successfully`);
    return JSON.stringify(result);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    runtime.log(`Error in onCronTrigger: ${errorMsg}`);
    return JSON.stringify({ status: "error", message: errorMsg });
  }
};

const initWorkflow = (config: WorkflowConfig) => {
  const cron = new cre.capabilities.CronCapability();
  return [
    cre.handler(
      cron.trigger({ schedule: config.schedule }),
      onCronTrigger
    ),
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
