export interface ConfidentialComputeConfig {
  confidentialCompute?: {
    enabledByDefault?: boolean
    strict?: boolean
    provider?: string
    tokenApiBaseUrl?: string
    hideSenderDefault?: boolean
  }
}

export interface ConfidentialComputeRequest {
  confidentialMode?: boolean
  confidentialFlags?: string[]
}

export interface ConfidentialContext {
  enabled: boolean
  strict: boolean
  provider: string
  tokenApiBaseUrl: string
  flags: string[]
  mode: "CONFIDENTIAL" | "PUBLIC"
}

function listFromUnknown(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

export function resolveConfidentialContext(
  config: ConfidentialComputeConfig,
  request: ConfidentialComputeRequest | undefined
): ConfidentialContext {
  const cc = config.confidentialCompute ?? {}
  const enabledByDefault = Boolean(cc.enabledByDefault)
  const strict = Boolean(cc.strict)
  const enabled =
    typeof request?.confidentialMode === "boolean" ? request.confidentialMode : enabledByDefault

  const defaultFlags = cc.hideSenderDefault === false ? [] : ["hide-sender"]
  const requestedFlags = listFromUnknown(request?.confidentialFlags)

  return {
    enabled,
    strict,
    provider: cc.provider ?? "CONVERGENCE_2026_TOKEN_API",
    tokenApiBaseUrl: cc.tokenApiBaseUrl ?? "https://convergence2026-token-api.cldev.cloud",
    flags: requestedFlags.length > 0 ? requestedFlags : defaultFlags,
    mode: enabled ? "CONFIDENTIAL" : "PUBLIC",
  }
}
