import {HTTPClient, consensusIdenticalAggregation, type Runtime, type HTTPSendRequester} from "@chainlink/cre-sdk";
import type {AutoPilotConfig, AutoPilotRequest, GeminiDecision} from "./autopilot.types";

type SecretCarrier = {
  getSecret: (request: unknown) => {result: () => {value?: string}};
};

function readSecretCompat(runtimeLike: SecretCarrier, id: string): string {
  // SDK/CLI versions differ on getSecret() request shape.
  try {
    const s = runtimeLike.getSecret({id}).result();
    const v = String(s.value ?? "").trim();
    if (v) return v;
  } catch {
    // fallback below
  }

  try {
    const s = runtimeLike.getSecret(id).result();
    const v = String(s.value ?? "").trim();
    if (v) return v;
  } catch {
    // handled by caller as missing
  }

  const envValue = String((globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env?.[id] ?? "").trim();
  if (envValue) return envValue;

  return "";
}

function toBase64Utf8(value: string): string {
  const maybeBuffer = globalThis as unknown as {Buffer?: {from?: (input: string) => {toString: (encoding: string) => string}}};
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

function coerceGeminiJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Gemini response is not JSON");
  return JSON.parse(match[0]);
}

function parseGeminiDecision(candidate: unknown): GeminiDecision {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("Gemini response payload is not an object");
  }
  const input = candidate as Record<string, unknown>;

  const actionRaw = typeof input.action === "string" ? input.action.toUpperCase() : "";
  const action = actionRaw === "EXECUTE" || actionRaw === "PAUSE" || actionRaw === "SKIP" ? actionRaw : "";
  if (!action) throw new Error("Gemini action must be EXECUTE | PAUSE | SKIP");

  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("Gemini confidence must be number in [0, 100]");
  }

  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new Error("Gemini reason is required");

  const operatorMessage = String(input.operatorMessage ?? "").trim() || reason;

  return {
    action,
    confidence,
    reason,
    operatorMessage
  };
}

function buildPrompt(request: AutoPilotRequest): string {
  return [
    "You are a strict DCA policy engine.",
    "Return ONLY compact JSON. No markdown, no prose.",
    'Schema: {"action":"EXECUTE|PAUSE|SKIP","confidence":0-100,"reason":"...","operatorMessage":"..."}',
    "Policy:",
    "- EXECUTE when request is normal periodic DCA and nothing anomalous in payload.",
    "- PAUSE when cadence or parameters suggest abnormal/high-risk behavior.",
    "- SKIP when uncertain.",
    "Request:",
    JSON.stringify(request)
  ].join("\n");
}

function fallbackDecision(reason: string): GeminiDecision {
  return {
    action: "SKIP",
    confidence: 0,
    reason,
    operatorMessage: `Fallback decision applied: ${reason}`
  };
}

type GeminiHttpResponse = {
  statusCode: number;
  geminiResponse: string;
  errorBody?: string;
};

type GeminiApiResponse = {
  candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>;
};

function buildGeminiRequest(
  url: string,
  prompt: string,
  apiKey: string
): (sendRequester: HTTPSendRequester, config: AutoPilotConfig) => GeminiHttpResponse {
  return (sendRequester: HTTPSendRequester, config: AutoPilotConfig): GeminiHttpResponse => {
    const body = {
      contents: [{parts: [{text: prompt}]}],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
        responseMimeType: "application/json"
      }
    };

    const req = {
      url,
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: toBase64Utf8(JSON.stringify(body))
    };

    const response = sendRequester.sendRequest(req).result();
    const bodyText = new TextDecoder().decode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        statusCode: response.statusCode,
        geminiResponse: "",
        errorBody: bodyText
      };
    }

    const payload = JSON.parse(bodyText) as GeminiApiResponse;
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Malformed Gemini response: missing text");

    return {
      statusCode: response.statusCode,
      geminiResponse: text
    };
  };
}

function resolveGeminiUrl(config: AutoPilotConfig): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
}

export function decideWithGemini(
  runtime: Runtime<AutoPilotConfig>,
  request: AutoPilotRequest
): GeminiDecision {
  const prompt = buildPrompt(request);
  const apiKey =
    readSecretCompat(runtime as unknown as SecretCarrier, "GEMINI_API_KEY") ||
    String(runtime.config.geminiApiKey ?? "").trim();
  if (!apiKey) {
    return fallbackDecision("GEMINI_API_KEY is missing");
  }

  try {
    const url = resolveGeminiUrl(runtime.config);
    const httpClient = new HTTPClient();
    const result = httpClient
      .sendRequest(
        runtime,
        buildGeminiRequest(url, prompt, apiKey),
        consensusIdenticalAggregation<GeminiHttpResponse>()
      )(runtime.config)
      .result();

    if (result.statusCode === 429) {
      return fallbackDecision("GEMINI_QUOTA_EXCEEDED");
    }
    if (result.statusCode === 401 || result.statusCode === 403) {
      return fallbackDecision("GEMINI_AUTH_FAILED");
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return fallbackDecision(`GEMINI_HTTP_${result.statusCode}`);
    }

    return parseGeminiDecision(coerceGeminiJson(result.geminiResponse));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackDecision(reason);
  }
}
