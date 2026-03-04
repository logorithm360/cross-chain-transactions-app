import type { Runtime } from "@chainlink/cre-sdk";
import { resolveRecommendation } from "../crossvault.recommendation";
import type { CrossVaultConfig, CrossVaultRequest, VaultRecommendation } from "../crossvault.types";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function baseConfig(): CrossVaultConfig {
  return {
    serviceName: "CrossVault",
    schedule: "0 9 * * 1",
    feature5Enabled: true,
    feature6Enabled: true,
    securityEnforcementMode: "ENFORCE",
    maxTransferAmountWei: "100000000000000000000",
    tokenAllowlist: [],
    tokenBlocklist: [],
    enabledLaneKeys: ["11155111->80002"],
    sourceChainWriteGasLimit: "900000",
    notificationsEnabled: true,
    requireExplicitApprovalForExecute: true,
    recommendationMode: "OPENAI",
    emitStructuredLogs: true,
    allowAiDestinationOverride: true,
    supportedOpportunityChainIds: [80002, 421614],
    openaiModel: "gpt-4o-mini",
    recommendationPolicy: {
      cacheTtlMs: 600000,
      maxRetries: 0,
      timeoutMs: 8000,
      allowedProtocols: ["Aave", "Compound"],
      fallbackExecutionMaxAmountWei: "300000000000000000",
      fallbackRequireApproval: true,
      opportunityCatalog: [
        {
          chainId: 80002,
          protocol: "Aave",
          strategyAction: "lend",
          baseApyBps: 620,
          risk: "LOW",
          enabled: true
        }
      ]
    },
    weeklyReviewEnabled: false,
    chainResolver: {
      enabled: true,
      registryAddressByChainId: { "11155111": "0x0000000000000000000000000000000000000001" },
      chainSelectorByChainId: { "11155111": "16015286601757825753" },
      mode: "onchain",
      cacheTtlMs: 30000,
      strict: true
    }
  };
}

function baseRequest(): CrossVaultRequest {
  return {
    walletChainId: 11155111,
    destinationChainId: 80002,
    serviceType: "CROSSVAULT",
    user: "0xe2a5d3EE095de5039D42B00ddc2991BD61E48D55",
    recipient: "0xb3CcDfCC821fC7693e0CbF4b352f7Ca51b33c89B",
    token: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
    amount: "100000000000000000",
    action: "transfer",
    intent: "DEPLOY",
    executionMode: "PLAN",
    riskProfile: "MEDIUM"
  };
}

function aiRecommendation(): VaultRecommendation {
  return {
    intent: "DEPLOY",
    riskProfile: "MEDIUM",
    allocationModel: "BALANCED",
    rebalanceCadence: "BIWEEKLY",
    slippageBpsCap: 80,
    recommendedDestinationChainId: 80002,
    protocol: "Aave",
    strategyAction: "stake",
    estimatedApyBps: 700,
    riskAssessment: "MEDIUM",
    confidence: 86,
    rationale: "AI selected Aave with best risk-adjusted return."
  };
}

function makeRuntime(config: CrossVaultConfig): Runtime<CrossVaultConfig> {
  return { config } as Runtime<CrossVaultConfig>;
}

function run(): void {
  const config = baseConfig();
  const request = baseRequest();
  const runtime = makeRuntime(config);

  const aiOk = resolveRecommendation(runtime, request, () => ({ ok: true, recommendation: aiRecommendation(), latencyMs: 123 }));
  assert(aiOk.ok, "AI success should return ok");
  if (!aiOk.ok) return;
  assert(aiOk.internalDecisionMeta.engine === "AI", "AI success should set engine=AI");

  const cacheHit = resolveRecommendation(runtime, request, () => ({
    ok: false,
    errorCode: "AI_TIMEOUT",
    errorMessage: "timeout",
    latencyMs: 50
  }));
  assert(cacheHit.ok, "Cache fallback should return ok");
  if (!cacheHit.ok) return;
  assert(cacheHit.internalDecisionMeta.engine === "CACHE", "After AI failure with cache, engine should be CACHE");

  const requestNoCache = { ...request, token: "0x1111111111111111111111111111111111111111" };
  const rulesHit = resolveRecommendation(runtime, requestNoCache, () => ({
    ok: false,
    errorCode: "AI_UNAVAILABLE",
    errorMessage: "down",
    latencyMs: 20
  }));
  assert(rulesHit.ok, "Rules fallback should return ok");
  if (!rulesHit.ok) return;
  assert(rulesHit.internalDecisionMeta.engine === "RULES", "Rules fallback should set engine=RULES");

  const noRulesConfig = baseConfig();
  noRulesConfig.recommendationPolicy.opportunityCatalog = [];
  const unavailable = resolveRecommendation(makeRuntime(noRulesConfig), requestNoCache, () => ({
    ok: false,
    errorCode: "AI_UNAVAILABLE",
    errorMessage: "down",
    latencyMs: 10
  }));
  assert(!unavailable.ok, "All tiers fail should return unavailable");
  if (unavailable.ok) return;
  assert(
    unavailable.userReason === "SERVICE_TEMPORARILY_UNAVAILABLE",
    "All tiers fail should map to SERVICE_TEMPORARILY_UNAVAILABLE"
  );

  console.log("CrossVault recommendation tests passed");
}

run();
