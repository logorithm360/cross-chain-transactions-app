import { HTTPClient, consensusIdenticalAggregation, ok, type NodeRuntime, type Runtime } from "@chainlink/cre-sdk";
import type { CrossVaultConfig, CrossVaultRequest, RiskProfile, StrategyAction, VaultRecommendation } from "./crossvault.types";

const OPENAI_API_KEY_SECRET_ID = "OPENAI_API_KEY";

type OpenAIHttpResponse = {
  statusCode: number;
  aiResponse: string;
  errorBody?: string;
};

type OpenAIChatCompletionsResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export type AIFailureCode =
  | "AI_TIMEOUT"
  | "AI_AUTH_FAILED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_INVALID_RESPONSE"
  | "AI_UNAVAILABLE";

export type AIRecommendationResult =
  | { ok: true; recommendation: VaultRecommendation; latencyMs: number }
  | { ok: false; errorCode: AIFailureCode; errorMessage: string; latencyMs: number };

function readRequiredSecret(runtime: Runtime<CrossVaultConfig>, secretId: string): string {
  const secret = runtime.getSecret({ id: secretId }).result();
  const value = String(secret.value ?? "").trim();
  if (!value) throw new Error(`${secretId} is missing`);
  return value;
}

function toBase64Utf8(value: string): string {
  const maybeBuffer = globalThis as unknown as {
    Buffer?: { from?: (input: string) => { toString: (encoding: string) => string } };
  };
  if (maybeBuffer.Buffer?.from) {
    return maybeBuffer.Buffer.from(value).toString("base64");
  }

  if (typeof btoa === "function") {
    const utf8 = new TextEncoder().encode(value);
    let binary = "";
    for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
    return btoa(binary);
  }

  throw new Error("No base64 encoder available in this runtime");
}

function coerceAiJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response is not JSON");
  return JSON.parse(match[0]);
}

function normalizeRisk(input: unknown, fallback: RiskProfile): RiskProfile {
  const v = String(input ?? "").toUpperCase();
  if (v === "LOW" || v === "MEDIUM" || v === "HIGH") return v;
  return fallback;
}

function normalizeAction(input: unknown): StrategyAction {
  const v = String(input ?? "").toLowerCase();
  if (v === "stake" || v === "lend" || v === "lp" || v === "vault") return v;
  return "stake";
}

function parseAiRecommendation(candidate: unknown, request: CrossVaultRequest): VaultRecommendation {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("AI recommendation payload is not an object");
  }
  const input = candidate as Record<string, unknown>;

  const recommendedDestinationChainId = Number(input.recommendedDestinationChainId ?? request.destinationChainId);
  if (!Number.isFinite(recommendedDestinationChainId) || recommendedDestinationChainId <= 0) {
    throw new Error("AI recommendedDestinationChainId must be a positive integer");
  }

  const estimatedApyBps = Number(input.estimatedApyBps ?? 0);
  if (!Number.isFinite(estimatedApyBps) || estimatedApyBps < 0) {
    throw new Error("AI estimatedApyBps must be >= 0");
  }

  const confidence = Number(input.confidence ?? 0);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("AI confidence must be number in [0,100]");
  }

  const protocol = String(input.protocol ?? "").trim();
  if (!protocol) throw new Error("AI protocol is required");

  const rationale = String(input.rationale ?? "").trim();
  if (!rationale) throw new Error("AI rationale is required");

  const allocationModelRaw = String(input.allocationModel ?? "").toUpperCase();
  const allocationModel =
    allocationModelRaw === "STABLE_HEAVY" || allocationModelRaw === "BALANCED" || allocationModelRaw === "GROWTH_HEAVY"
      ? allocationModelRaw
      : request.riskProfile === "LOW"
        ? "STABLE_HEAVY"
        : request.riskProfile === "HIGH"
          ? "GROWTH_HEAVY"
          : "BALANCED";

  const cadenceRaw = String(input.rebalanceCadence ?? "").toUpperCase();
  const rebalanceCadence =
    cadenceRaw === "WEEKLY" || cadenceRaw === "BIWEEKLY" || cadenceRaw === "MONTHLY" ? cadenceRaw : "BIWEEKLY";

  const slippageBpsCap = Number(input.slippageBpsCap ?? 80);

  return {
    intent: request.intent,
    riskProfile: request.riskProfile,
    allocationModel,
    rebalanceCadence,
    slippageBpsCap: Number.isFinite(slippageBpsCap) && slippageBpsCap > 0 ? slippageBpsCap : 80,
    recommendedDestinationChainId,
    protocol,
    strategyAction: normalizeAction(input.strategyAction),
    estimatedApyBps,
    riskAssessment: normalizeRisk(input.riskAssessment, request.riskProfile),
    confidence,
    rationale
  };
}

function buildPrompt(request: CrossVaultRequest, config: CrossVaultConfig): string {
  return [
    "You are CrossVault research engine.",
    "Return ONLY compact JSON. No markdown.",
    '{"recommendedDestinationChainId":number,"protocol":"string","strategyAction":"stake|lend|lp|vault","estimatedApyBps":number,"riskAssessment":"LOW|MEDIUM|HIGH","allocationModel":"STABLE_HEAVY|BALANCED|GROWTH_HEAVY","rebalanceCadence":"WEEKLY|BIWEEKLY|MONTHLY","slippageBpsCap":number,"confidence":0-100,"rationale":"string"}',
    "Policy constraints:",
    `- recommendedDestinationChainId MUST be one of: ${JSON.stringify(config.supportedOpportunityChainIds)}`,
    `- User risk profile: ${request.riskProfile}`,
    `- User history summary: ${request.userHistorySummary ?? "unknown"}`,
    `- Prior ops: stake=${request.priorStakeOps ?? 0}, swap=${request.priorSwapOps ?? 0}`,
    "Request context:",
    JSON.stringify({
      walletChainId: request.walletChainId,
      destinationChainId: request.destinationChainId,
      token: request.token,
      amount: request.amount,
      intent: request.intent,
      action: request.action
    })
  ].join("\n");
}

function resolveOpenAIUrl(): string {
  return "https://api.openai.com/v1/chat/completions";
}

function msToDurationString(ms: number): string {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return `${seconds}s`;
}

export function fetchOpenAIRecommendation(
  runtime: Runtime<CrossVaultConfig>,
  request: CrossVaultRequest
): AIRecommendationResult {
  const started = Date.now();

  runtime.log(
    `[AI] Starting OpenAI request: intent=${request.intent}, riskProfile=${request.riskProfile}, destinationChainId=${request.destinationChainId}`
  );
  runtime.log(
    `[AI] openaiModel=${runtime.config.openaiModel}, supportedChains=${JSON.stringify(runtime.config.supportedOpportunityChainIds)}`
  );

  if (!runtime.config.openaiModel || runtime.config.openaiModel.trim().length === 0) {
    return {
      ok: false,
      errorCode: "AI_AUTH_FAILED",
      errorMessage: "openaiModel is not configured in CrossVaultConfig",
      latencyMs: Date.now() - started
    };
  }

  try {
    const url = resolveOpenAIUrl();
    const prompt = buildPrompt(request, runtime.config);
    const apiKey = readRequiredSecret(runtime, OPENAI_API_KEY_SECRET_ID);

    runtime.log(`[AI] API key found before node mode: ${apiKey ? `yes (length=${apiKey.length})` : "NO"}`);

    const runNodeOpenAI = (nodeRuntime: NodeRuntime<CrossVaultConfig>): OpenAIHttpResponse => {
      runtime.log("[AI] Inside runInNodeMode, issuing OpenAI request...");

      const body = {
        model: runtime.config.openaiModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are CrossVault research engine. Return only compact JSON matching the requested schema."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      };

      const req = {
        url,
        method: "POST" as const,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: toBase64Utf8(JSON.stringify(body)),
        timeout: msToDurationString(nodeRuntime.config.recommendationPolicy.timeoutMs),
        cacheSettings: {
          store: false,
          maxAge: "0s"
        }
      };

      const httpClient = new HTTPClient();
      const response = httpClient.sendRequest(nodeRuntime, req).result();

      runtime.log(`[AI] HTTP response statusCode: ${response.statusCode}`);

      const bodyText = new TextDecoder().decode(response.body);

      if (!ok(response)) {
        runtime.log(`[AI] HTTP error response: ${bodyText}`);
        return {
          statusCode: response.statusCode,
          aiResponse: "",
          errorBody: bodyText
        };
      }

      const payload = JSON.parse(bodyText) as OpenAIChatCompletionsResponse;
      const text = payload.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("Malformed OpenAI response: missing choices[0].message.content");
      }

      return {
        statusCode: response.statusCode,
        aiResponse: text
      };
    };

    const result = runtime
      .runInNodeMode(runNodeOpenAI, consensusIdenticalAggregation<OpenAIHttpResponse>())()
      .result();

    runtime.log(`[AI] Final result statusCode: ${result.statusCode}`);

    if (result.statusCode === 401 || result.statusCode === 403) {
      return {
        ok: false,
        errorCode: "AI_AUTH_FAILED",
        errorMessage: `OpenAI auth failed (${result.statusCode})`,
        latencyMs: Date.now() - started
      };
    }

    if (result.statusCode === 429) {
      return {
        ok: false,
        errorCode: "AI_QUOTA_EXCEEDED",
        errorMessage: "OpenAI quota exceeded",
        latencyMs: Date.now() - started
      };
    }

    if (result.statusCode < 200 || result.statusCode >= 300) {
      return {
        ok: false,
        errorCode: "AI_UNAVAILABLE",
        errorMessage: `OpenAI HTTP ${result.statusCode}: ${result.errorBody ?? ""}`,
        latencyMs: Date.now() - started
      };
    }

    const recommendation = parseAiRecommendation(coerceAiJson(result.aiResponse), request);
    return { ok: true, recommendation, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.log(`[AI] Caught error: ${message}`);
    const lower = message.toLowerCase();

    if (lower.includes("timeout")) {
      return { ok: false, errorCode: "AI_TIMEOUT", errorMessage: message, latencyMs: Date.now() - started };
    }
    if (lower.includes("auth") || lower.includes("secret") || lower.includes("api key") || lower.includes("missing")) {
      return { ok: false, errorCode: "AI_AUTH_FAILED", errorMessage: message, latencyMs: Date.now() - started };
    }
    return { ok: false, errorCode: "AI_INVALID_RESPONSE", errorMessage: message, latencyMs: Date.now() - started };
  }
}
