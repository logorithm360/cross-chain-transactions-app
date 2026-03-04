import type {
  CrossVaultConfig,
  CrossVaultRequest,
  OpportunityRule,
  RecommendationInternalMeta,
  RiskProfile,
  UserBlockedReason,
  VaultRecommendation
} from "./crossvault.types";
import { fetchOpenAIRecommendation, type AIFailureCode } from "./crossvault.gemini";
import type { Runtime } from "@chainlink/cre-sdk";

type CachedRecommendation = {
  recommendation: VaultRecommendation;
  expiresAt: number;
};

type RecommendationResult =
  | { ok: true; publicRecommendation: VaultRecommendation; internalDecisionMeta: RecommendationInternalMeta }
  | {
      ok: false;
      userReason: UserBlockedReason;
      userMessage: string;
      internalDecisionMeta: RecommendationInternalMeta;
    };

const recommendationCache = new Map<string, CachedRecommendation>();

export type RecommendationFetcher = typeof fetchOpenAIRecommendation;

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function riskLevel(risk: RiskProfile): number {
  if (risk === "LOW") return 1;
  if (risk === "MEDIUM") return 2;
  return 3;
}

function allocationModelForRisk(risk: RiskProfile): "STABLE_HEAVY" | "BALANCED" | "GROWTH_HEAVY" {
  if (risk === "LOW") return "STABLE_HEAVY";
  if (risk === "HIGH") return "GROWTH_HEAVY";
  return "BALANCED";
}

function cadenceForRisk(risk: RiskProfile): "WEEKLY" | "BIWEEKLY" | "MONTHLY" {
  if (risk === "LOW") return "MONTHLY";
  if (risk === "HIGH") return "WEEKLY";
  return "BIWEEKLY";
}

function slippageForRisk(risk: RiskProfile): number {
  if (risk === "LOW") return 40;
  if (risk === "HIGH") return 120;
  return 80;
}

function cacheKey(request: CrossVaultRequest): string {
  return [
    request.walletChainId,
    request.intent,
    request.riskProfile,
    normalizeAddress(request.token)
  ].join("|");
}

function isProtocolAllowed(config: CrossVaultConfig, protocol: string): boolean {
  const allowed = config.recommendationPolicy.allowedProtocols;
  if (allowed.length === 0) return true;
  return allowed.some((p) => p.toLowerCase() === protocol.toLowerCase());
}

function validateRecommendation(config: CrossVaultConfig, recommendation: VaultRecommendation): string[] {
  const flags: string[] = [];
  if (!config.supportedOpportunityChainIds.includes(recommendation.recommendedDestinationChainId)) {
    flags.push("CHAIN_NOT_SUPPORTED");
  }
  if (!isProtocolAllowed(config, recommendation.protocol)) {
    flags.push("PROTOCOL_NOT_ALLOWED");
  }
  if (recommendation.estimatedApyBps < 0) {
    flags.push("NEGATIVE_APY");
  }
  return flags;
}

function mapAiFailureCode(code: AIFailureCode): string {
  if (code === "AI_TIMEOUT") return "AI_TIMEOUT";
  if (code === "AI_AUTH_FAILED") return "AI_AUTH_FAILED";
  if (code === "AI_QUOTA_EXCEEDED") return "AI_QUOTA_EXCEEDED";
  if (code === "AI_INVALID_RESPONSE") return "AI_INVALID_RESPONSE";
  return "AI_UNAVAILABLE";
}

function selectRuleCandidate(config: CrossVaultConfig, request: CrossVaultRequest): OpportunityRule | undefined {
  const requestedRisk = riskLevel(request.riskProfile);
  const candidates = config.recommendationPolicy.opportunityCatalog
    .filter((x) => x.enabled)
    .filter((x) => config.supportedOpportunityChainIds.includes(x.chainId))
    .filter((x) => isProtocolAllowed(config, x.protocol))
    .filter((x) => riskLevel(x.risk) <= requestedRisk);

  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => {
    if (b.baseApyBps !== a.baseApyBps) return b.baseApyBps - a.baseApyBps;
    return riskLevel(a.risk) - riskLevel(b.risk);
  });

  return candidates[0];
}

function recommendationFromRule(request: CrossVaultRequest, rule: OpportunityRule): VaultRecommendation {
  return {
    intent: request.intent,
    riskProfile: request.riskProfile,
    allocationModel: allocationModelForRisk(request.riskProfile),
    rebalanceCadence: cadenceForRisk(request.riskProfile),
    slippageBpsCap: slippageForRisk(request.riskProfile),
    recommendedDestinationChainId: rule.chainId,
    protocol: rule.protocol,
    strategyAction: rule.strategyAction,
    estimatedApyBps: rule.baseApyBps,
    riskAssessment: rule.risk,
    confidence: 55,
    rationale: `Policy-ranked opportunity selected from catalog: ${rule.protocol} on chain ${rule.chainId}.`
  };
}

function safeUnavailableResult(meta: RecommendationInternalMeta): RecommendationResult {
  return {
    ok: false,
    userReason: "SERVICE_TEMPORARILY_UNAVAILABLE",
    userMessage: "Recommendation service is temporarily unavailable. Please retry shortly.",
    internalDecisionMeta: meta
  };
}

export function resolveRecommendation(
  runtime: Runtime<CrossVaultConfig>,
  request: CrossVaultRequest,
  fetcher: RecommendationFetcher = fetchOpenAIRecommendation
): RecommendationResult {
  const retries = Math.max(0, runtime.config.recommendationPolicy.maxRetries ?? 0);
  const key = cacheKey(request);
  let lastAiCode = "AI_UNAVAILABLE";

  for (let i = 0; i <= retries; i++) {
    const ai = fetcher(runtime, request);
    if (ai.ok) {
      const policyFlags = validateRecommendation(runtime.config, ai.recommendation);
      if (policyFlags.length === 0) {
        recommendationCache.set(key, {
          recommendation: ai.recommendation,
          expiresAt: Date.now() + runtime.config.recommendationPolicy.cacheTtlMs
        });
        return {
          ok: true,
          publicRecommendation: ai.recommendation,
          internalDecisionMeta: {
            engine: "AI",
            usedFallback: false,
            latencyMs: ai.latencyMs,
            policyFlags: ["AI_OK"]
          }
        };
      }
      lastAiCode = "AI_POLICY_VIOLATION";
    } else {
      lastAiCode = mapAiFailureCode(ai.errorCode);
    }
  }

  const cached = recommendationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const policyFlags = validateRecommendation(runtime.config, cached.recommendation);
    if (policyFlags.length === 0) {
      return {
        ok: true,
        publicRecommendation: { ...cached.recommendation, confidence: Math.max(cached.recommendation.confidence, 60) },
        internalDecisionMeta: {
          engine: "CACHE",
          usedFallback: true,
          policyFlags: ["CACHE_HIT", "CACHE_POLICY_OK"],
          internalReasonCode: lastAiCode
        }
      };
    }
  }

  const rule = selectRuleCandidate(runtime.config, request);
  if (rule) {
    const recommendation = recommendationFromRule(request, rule);
    const policyFlags = validateRecommendation(runtime.config, recommendation);
    if (policyFlags.length === 0) {
      return {
        ok: true,
        publicRecommendation: recommendation,
        internalDecisionMeta: {
          engine: "RULES",
          usedFallback: true,
          policyFlags: ["RULES_HIT", "RULES_POLICY_OK"],
          internalReasonCode: lastAiCode
        }
      };
    }
  }

  return safeUnavailableResult({
    engine: "RULES",
    usedFallback: true,
    policyFlags: ["CACHE_MISS", "RULES_NO_MATCH"],
    internalReasonCode: lastAiCode
  });
}
