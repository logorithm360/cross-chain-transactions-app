import {HTTPClient, consensusIdenticalAggregation, type Runtime, type HTTPSendRequester} from "@chainlink/cre-sdk";
import type {AIDecision, AutoPilotConfig, AutoPilotRequest} from "./autopilot.types";

type SecretCarrier = {
  getSecret: (request: unknown) => {result: () => {value?: string}};
};

type OpenAIHttpResponse = {
  statusCode: number;
  openaiResponse: string;
  errorBody?: string;
};

type OpenAIChatCompletion = {
  choices?: Array<{message?: {content?: string}}>;
};

function readSecretCompat(runtimeLike: SecretCarrier, id: string): string {
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

function coerceOpenAIJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("OpenAI response is not JSON");
  return JSON.parse(match[0]);
}

function parseOpenAIDecision(candidate: unknown): AIDecision {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("OpenAI response payload is not an object");
  }
  const input = candidate as Record<string, unknown>;

  const actionRaw = typeof input.action === "string" ? input.action.toUpperCase() : "";
  const action = actionRaw === "EXECUTE" || actionRaw === "PAUSE" || actionRaw === "SKIP" ? actionRaw : "";
  if (!action) throw new Error("OpenAI action must be EXECUTE | PAUSE | SKIP");

  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error("OpenAI confidence must be number in [0, 100]");
  }

  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new Error("OpenAI reason is required");

  const operatorMessage = String(input.operatorMessage ?? "").trim() || reason;

  return {
    action,
    confidence,
    reason,
    operatorMessage
  };
}

function buildPrompt(request: AutoPilotRequest): {system: string; user: string} {
  return {
    system: [
      "You are a strict DCA policy engine.",
      "Return ONLY compact JSON. No markdown, no prose.",
      'Schema: {"action":"EXECUTE|PAUSE|SKIP","confidence":0-100,"reason":"...","operatorMessage":"..."}',
      "Policy:",
      "- EXECUTE when request is normal periodic DCA and nothing anomalous in payload.",
      "- PAUSE when cadence or parameters suggest abnormal/high-risk behavior.",
      "- SKIP when uncertain."
    ].join("\n"),
    user: JSON.stringify(request)
  };
}

function fallbackDecision(reason: string): AIDecision {
  return {
    action: "SKIP",
    confidence: 0,
    reason,
    operatorMessage: `Fallback decision applied: ${reason}`
  };
}

function buildOpenAIRequest(
  prompt: {system: string; user: string},
  apiKey: string,
  model: string
): (sendRequester: HTTPSendRequester, _config: AutoPilotConfig) => OpenAIHttpResponse {
  return (sendRequester: HTTPSendRequester, _config: AutoPilotConfig): OpenAIHttpResponse => {
    const body = {
      model,
      temperature: 0,
      response_format: {type: "json_object"},
      messages: [
        {role: "system", content: prompt.system},
        {role: "user", content: prompt.user}
      ]
    };

    const req = {
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST" as const,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: toBase64Utf8(JSON.stringify(body))
    };

    const response = sendRequester.sendRequest(req).result();
    const bodyText = new TextDecoder().decode(response.body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        statusCode: response.statusCode,
        openaiResponse: "",
        errorBody: bodyText
      };
    }

    const payload = JSON.parse(bodyText) as OpenAIChatCompletion;
    const text = payload.choices?.[0]?.message?.content;
    if (!text) throw new Error("Malformed OpenAI response: missing text");

    return {
      statusCode: response.statusCode,
      openaiResponse: text
    };
  };
}

export function decideWithOpenAI(
  runtime: Runtime<AutoPilotConfig>,
  request: AutoPilotRequest
): AIDecision {
  const prompt = buildPrompt(request);
  const apiKey =
    readSecretCompat(runtime as unknown as SecretCarrier, "OPENAI_API_KEY") ||
    String(runtime.config.openaiApiKey ?? "").trim();
  if (!apiKey) {
    return fallbackDecision("OPENAI_API_KEY_MISSING");
  }

  try {
    const httpClient = new HTTPClient();
    const result = httpClient
      .sendRequest(
        runtime,
        buildOpenAIRequest(prompt, apiKey, runtime.config.openaiModel),
        consensusIdenticalAggregation<OpenAIHttpResponse>()
      )(runtime.config)
      .result();

    if (result.statusCode === 429) {
      return fallbackDecision("OPENAI_QUOTA_EXCEEDED");
    }
    if (result.statusCode === 401 || result.statusCode === 403) {
      return fallbackDecision("OPENAI_AUTH_FAILED");
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      return fallbackDecision(`OPENAI_HTTP_${result.statusCode}`);
    }

    return parseOpenAIDecision(coerceOpenAIJson(result.openaiResponse));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fallbackDecision(reason);
  }
}
