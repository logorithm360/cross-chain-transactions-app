export type ServiceType = "DCA" | "CHAINSHIELD" | "CROSSVAULT" | "CHAINALERT"

export type ServiceAction =
  | "DCA_CREATE_TIMED_ORDER"
  | "DCA_SET_ORDER_PAUSED"
  | "DCA_CANCEL_ORDER"
  | "DCA_FUND_LINK"
  | "CHAINALERT_UPSERT_RULE"
  | "CHAINALERT_SET_RULE_ENABLED"
  | "CHAINSHIELD_TRANSFER"
  | "CROSSVAULT_DEPOSIT"

export type IntentStatus =
  | "CREATED"
  | "SIGN_REQUESTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED"

export type IntentExecutionMode = "PUBLIC_EVM" | "CONFIDENTIAL_PRIVATE"

export type IntentPrivacyOutcome = "EXPLORER_VISIBLE" | "EXPLORER_NOT_APPLICABLE"

export interface ConfidentialEip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

export interface ConfidentialComputeMode {
  enabled: boolean
  strict: boolean
  provider: "CONVERGENCE_2026_TOKEN_API"
  tokenApiBaseUrl: string
  hideSenderDefault: boolean
  eip712Domain: ConfidentialEip712Domain
}

export interface ConfidentialIntentMeta {
  enabled: boolean
  strict: boolean
  provider: ConfidentialComputeMode["provider"]
  tokenApiBaseUrl: string
  hideSender: boolean
}

export interface BuiltWithConfidentialMode {
  enabled: boolean
  strict: boolean
  provider: ConfidentialComputeMode["provider"]
}

export interface ConfidentialSubmissionRef {
  provider: ConfidentialComputeMode["provider"]
  privateTransferId: string
  submittedAt: string
}

export interface WalletContext {
  account: `0x${string}`
  chainId: number
  chainIdHex: `0x${string}`
  providerId?: string
  providerName?: string
}

export interface PreparedTransaction {
  txId: string
  chainId: number
  chainIdHex: `0x${string}`
  to: `0x${string}`
  data: `0x${string}`
  value: `0x${string}`
  description: string
}

export interface IntentBuildRequest {
  sessionId: string
  nonce: string
  serviceType: ServiceType
  action: ServiceAction
  params: Record<string, unknown>
}

export interface PreparedIntentBundle {
  intentId: string
  sessionId: string
  nonce: string
  serviceType: ServiceType
  action: ServiceAction
  status: IntentStatus
  executionMode: IntentExecutionMode
  privacyOutcome: IntentPrivacyOutcome
  builtWithConfidentialMode: BuiltWithConfidentialMode
  createdAt: string
  expiresAt: string
  transactions: PreparedTransaction[]
  params: Record<string, unknown>
  submittedTxHash?: `0x${string}`
  confidentialRef?: ConfidentialSubmissionRef
  walletContext?: WalletContext
  error?: string
}

export interface BridgeSessionStartResponse {
  sessionId: string
  token: string
  expiresAt: string
  baseUrl: string
  signerUrlHint: string
  confidentialMode: ConfidentialComputeMode
}

export interface BridgeEvent {
  type:
    | "SESSION_CREATED"
    | "SESSION_WALLET_UPDATED"
    | "SESSION_CONFIDENTIAL_MODE_UPDATED"
    | "INTENT_CREATED"
    | "INTENT_SUBMITTED"
    | "INTENT_CONFIDENTIAL_SUBMITTED"
    | "INTENT_CONFIRMED"
    | "INTENT_CONFIDENTIAL_CONFIRMED"
    | "INTENT_FAILED"
    | "INTENT_CONFIDENTIAL_FAILED"
    | "INTENT_EXPIRED"
  sessionId: string
  intentId?: string
  payload?: Record<string, unknown>
  at: string
}
