import {HTTPClient, consensusIdenticalAggregation, type HTTPSendRequester, type Runtime} from "@chainlink/cre-sdk";
import type {Feature4AIContext, Feature4Config, Feature4OpenAIAlertInput} from "./chainAlert.intelligence.types";

type SecretCarrier = {
  getSecret: (request: unknown) => {result: () => {value?: string}};
};

type OpenAIResponse = {
  statusCode: number;
  body: string;
};

type OpenAIChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

function readSecretCompat(runtimeLike: SecretCarrier, id: string): string {
  try {
    const s = runtimeLike.getSecret({id}).result();
    const v = String(s.value ?? "").trim();
    if (v) return v;
  } catch {
    // fallback
  }

  try {
    const s = runtimeLike.getSecret(id).result();
    const v = String(s.value ?? "").trim();
    if (v) return v;
  } catch {
    // fallback
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

function fallbackContext(model: string, reasonCode: string, details = "AI analysis unavailable"): Feature4AIContext {
  return {
    severity: "MEDIUM",
    confidence: 0,
    summary: details,
    recommendation: "Review alert details manually and confirm on-chain state before taking action.",
    model,
    source: "FALLBACK",
    reasonCode
  };
}

function parseAIContext(raw: string, model: string): Feature4AIContext {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const severityRaw = String(parsed.severity ?? "").toUpperCase();
  const severity = severityRaw === "LOW" || severityRaw === "MEDIUM" || severityRaw === "HIGH" || severityRaw === "CRITICAL"
    ? severityRaw
    : "MEDIUM";

  const confidence = Number(parsed.confidence ?? 0);
  const summary = String(parsed.summary ?? "").trim();
  const recommendation = String(parsed.recommendation ?? "").trim();

  if (!summary || !recommendation || !Number.isFinite(confidence)) {
    throw new Error("OPENAI_INVALID_RESPONSE");
  }

  return {
    severity,
    confidence: Math.max(0, Math.min(100, confidence)),
    summary,
    recommendation,
    model,
    source: "OPENAI"
  };
}

function buildPrompt(input: Feature4OpenAIAlertInput): {system: string; user: string} {
  return {
    system: [
      "You are a crypto risk analyst for cross-chain automation alerts.",
      "Return only compact JSON with keys: severity, confidence, summary, recommendation.",
      "severity must be LOW|MEDIUM|HIGH|CRITICAL.",
      "Do not include markdown or extra keys."
    ].join("\n"),
    user: JSON.stringify(input)
  };
}

function buildRequest(
  apiKey: string,
  model: string,
  input: Feature4OpenAIAlertInput
): (sendRequester: HTTPSendRequester, _config: Feature4Config) => OpenAIResponse {
  const prompt = buildPrompt(input);
  return (sendRequester: HTTPSendRequester, _config: Feature4Config): OpenAIResponse => {
    const body = {
      model,
      temperature: 0,
      response_format: {type: "json_object"},
      messages: [
        {role: "system", content: prompt.system},
        {role: "user", content: prompt.user}
      ]
    };

    const response = sendRequester
      .sendRequest({
        url: "https://api.openai.com/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: toBase64Utf8(JSON.stringify(body))
      })
      .result();

    return {
      statusCode: response.statusCode,
      body: new TextDecoder().decode(response.body)
    };
  };
}

export function analyzeAlertWithOpenAI(
  runtime: Runtime<Feature4Config>,
  input: Feature4OpenAIAlertInput
): Feature4AIContext {
  const model = runtime.config.openaiModel;
  const apiKey =
    readSecretCompat(runtime as unknown as SecretCarrier, "OPENAI_API_KEY") ||
    String(runtime.config.openaiApiKey ?? "").trim();

  if (!apiKey) {
    return fallbackContext(model, "OPENAI_API_KEY_MISSING");
  }

  try {
    const httpClient = new HTTPClient();
    const response = httpClient
      .sendRequest(
        runtime,
        buildRequest(apiKey, model, input),
        consensusIdenticalAggregation<OpenAIResponse>()
      )(runtime.config)
      .result();

    if (response.statusCode === 401 || response.statusCode === 403) {
      return fallbackContext(model, "OPENAI_AUTH_FAILED");
    }
    if (response.statusCode === 429) {
      return fallbackContext(model, "OPENAI_RATE_LIMITED");
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return fallbackContext(model, `OPENAI_HTTP_${response.statusCode}`);
    }

    const payload = JSON.parse(response.body) as OpenAIChatCompletion;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) return fallbackContext(model, "OPENAI_EMPTY_CHOICE");

    return parseAIContext(content, model);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackContext(model, "OPENAI_EXCEPTION", reason);
  }
}
