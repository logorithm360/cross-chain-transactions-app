export type ResolutionState = "READY" | "BLOCKED" | "DEGRADED";
export type EnforcementMode = "MONITOR" | "ENFORCE";
export type VaultIntent = "DEPLOY" | "REBALANCE" | "WITHDRAW";
export type VaultExecutionMode = "PLAN" | "EXECUTE";
export type RiskProfile = "LOW" | "MEDIUM" | "HIGH";
export type RecommendationMode = "OPENAI";
export type StrategyAction = "stake" | "lend" | "lp" | "vault";
export type RecommendationEngine = "AI" | "CACHE" | "RULES";
export type UserBlockedReason = "POLICY_BLOCKED" | "UNSUPPORTED_ROUTE" | "SERVICE_TEMPORARILY_UNAVAILABLE";

export type BlockedReason =
  | "CHAIN_UNSUPPORTED"
  | "LANE_DISABLED"
  | "CONTRACT_NOT_DEPLOYED"
  | "TOKEN_MAPPING_MISSING"
  | "SECURITY_BLOCKED"
  | "FEE_ESTIMATION_FAILED"
  | "FINALITY_DELAYED"
  | "POLICY_BLOCKED"
  | "UNSUPPORTED_ROUTE"
  | "SERVICE_TEMPORARILY_UNAVAILABLE";

export interface CrossVaultRequest {
  walletChainId: number;
  destinationChainId: number;
  serviceType: string;
  user: string;
  recipient: string;
  token: string;
  amount: string;
  action: string;
  intent: VaultIntent;
  executionMode: VaultExecutionMode;
  riskProfile: RiskProfile;
  approvalRequired?: boolean;
  approved?: boolean;
  deadline?: number;
  userHistorySummary?: string;
  priorStakeOps?: number;
  priorSwapOps?: number;
}

export interface VaultRecommendation {
  intent: VaultIntent;
  riskProfile: RiskProfile;
  allocationModel: "STABLE_HEAVY" | "BALANCED" | "GROWTH_HEAVY";
  rebalanceCadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY";
  slippageBpsCap: number;
  recommendedDestinationChainId: number;
  protocol: string;
  strategyAction: StrategyAction;
  estimatedApyBps: number;
  riskAssessment: RiskProfile;
  confidence: number;
  rationale: string;
}

export interface RecommendationInternalMeta {
  engine: RecommendationEngine;
  usedFallback: boolean;
  latencyMs?: number;
  policyFlags: string[];
  internalReasonCode?: string;
}

export interface OpportunityRule {
  chainId: number;
  protocol: string;
  strategyAction: StrategyAction;
  baseApyBps: number;
  risk: RiskProfile;
  enabled: boolean;
}

export interface RecommendationPolicy {
  cacheTtlMs: number;
  maxRetries: number;
  timeoutMs: number;
  allowedProtocols: string[];
  fallbackExecutionMaxAmountWei: string;
  fallbackRequireApproval: boolean;
  opportunityCatalog: OpportunityRule[];
}

export interface ResolvedExecutionConfig {
  state: ResolutionState;
  blockedReason?: BlockedReason;
  degradedReason?: string;
  sourceChainId: number;
  sourceChainName: string;
  sourceChainSelector: string;
  destinationChainId: number;
  destinationChainName: string;
  destinationChainSelector: string;
  serviceType: string;
  token: string;
  amount: string;
  action: string;
  recipient: string;
  contracts: {
    sourceSender?: string;
    destinationReceiver?: string;
    securityManager?: string;
    tokenVerifier?: string;
    userRecordRegistry?: string;
  };
  estimatedFeeWei?: string;
}

export interface PreflightReport {
  sourceChainSupported: boolean;
  destinationChainSupported: boolean;
  laneEnabled: boolean;
  contractsResolved: boolean;
  tokenMapped: boolean;
  amountParsed: boolean;
  estimatedFeeWei?: string;
}

export interface SecurityDecision {
  allow: boolean;
  enforcementMode: EnforcementMode;
  reasonCode?: string;
  incidentLogged: boolean;
}

export interface WorkflowRecord {
  phase: string;
  externalEventKey: string;
  status: string;
  metadataHash: string;
}

export interface CrossVaultOutcome {
  requestId: string;
  timestamp: string;
  status: ResolutionState | "EXECUTION_SUBMITTED";
  resolver: ResolvedExecutionConfig;
  preflight: PreflightReport;
  security: SecurityDecision;
  recommendation: VaultRecommendation;
  records: WorkflowRecord[];
  approvalRequest?: {
    required: boolean;
    approved: boolean;
    message: string;
  };
  execution: {
    submitted: boolean;
    message: string;
    reasonCode?: UserBlockedReason | string;
    txHash?: string;
  };
  opsMeta?: RecommendationInternalMeta;
  notifications?: string[];
}

export interface CrossVaultConfig {
  serviceName: string;
  schedule: string;
  authorizedEVMAddresses?: string[];
  feature5Enabled: boolean;
  feature6Enabled: boolean;
  securityEnforcementMode: EnforcementMode;
  maxTransferAmountWei: string;
  tokenAllowlist: string[];
  tokenBlocklist: string[];
  enabledLaneKeys: string[];
  securityManagerContract?: string;
  tokenVerifierContract?: string;
  userRecordRegistryContract?: string;
  sourceChainWriteGasLimit?: string;
  notificationsEnabled?: boolean;
  requireExplicitApprovalForExecute: boolean;
  recommendationMode: RecommendationMode;
  emitStructuredLogs?: boolean;
  allowAiDestinationOverride: boolean;
  supportedOpportunityChainIds: number[];
  openaiModel: string;
  recommendationPolicy: RecommendationPolicy;
  weeklyReviewEnabled: boolean;
  reviewRequest?: CrossVaultRequest;
  chainResolver: {
    enabled: boolean;
    registryAddressByChainId: Record<string, string>;
    chainSelectorByChainId: Record<string, string>;
    chainNameByChainId?: Record<string, string>;
    mode: "onchain";
    cacheTtlMs: number;
    strict: boolean;
  };
}
