import {HTTPClient, consensusIdenticalAggregation, type HTTPSendRequester, type Runtime} from "@chainlink/cre-sdk";
import type {Feature4Config} from "./chainAlert.intelligence.types";

export function normalizeAddress(input: string): string {
  return input.toLowerCase();
}

export function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function parseRuleParams(paramsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(paramsJson) as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function numberFrom(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return asNum;
  }
  return fallback;
}

export function stringFrom(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  return fallback;
}

export function boolFrom(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

export function stringArrayFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x)).filter((x) => x.length > 0);
}

export function deterministicFingerprint(parts: Array<string | number | boolean>): string {
  const raw = parts.map((x) => String(x)).join("|");
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 16777619 + raw.charCodeAt(i)) >>> 0;
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

type HTTPJsonResponse = {
  statusCode: number;
  body: string;
};

export function httpGetJson(
  runtime: Runtime<Feature4Config>,
  url: string,
  headers: Record<string, string> = {}
): Record<string, unknown> | undefined {
  try {
    const client = new HTTPClient();
    const result = client
      .sendRequest(
        runtime,
        (sendRequester: HTTPSendRequester, _config: Feature4Config): HTTPJsonResponse => {
          const response = sendRequester.sendRequest({url, method: "GET", headers}).result();
          return {
            statusCode: response.statusCode,
            body: new TextDecoder().decode(response.body)
          };
        },
        consensusIdenticalAggregation<HTTPJsonResponse>()
      )(runtime.config)
      .result();

    if (result.statusCode < 200 || result.statusCode >= 300) {
      return undefined;
    }

    const parsed = JSON.parse(result.body) as unknown;
    if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

export function readSecretCompat(runtimeLike: {getSecret: (request: unknown) => {result: () => {value?: string}}}, id: string): string {
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
