export type ResolutionState = "READY" | "BLOCKED" | "DEGRADED";
export type EnforcementMode = "MONITOR" | "ENFORCE";
export type ExecutionMode = "CREATE_ORDER" | "RUN_UPKEEP";
export type DecisionMode = "OPENAI";
export type DecisionAction = "EXECUTE" | "PAUSE" | "SKIP";
export type OpenAIFailurePolicy = "SKIP" | "EXECUTE_SAFE";

export type BlockedReason =
  | "CHAIN_UNSUPPORTED"
  | "LANE_DISABLED"
  | "CONTRACT_NOT_DEPLOYED"
  | "TOKEN_MAPPING_MISSING"
  | "SECURITY_BLOCKED"
  | "FEE_ESTIMATION_FAILED";

export interface AutoPilotRequest {
  walletChainId: number;
  destinationChainId: number;
  serviceType: string;
  executionMode: ExecutionMode;
  user: string;
  token: string;
  amount: string;
  recipient: string;
  receiverContract: string;
  action: string;
  cadenceSeconds: number;
  recurring: boolean;
  maxExecutions: number;
  deadline: number;
  confidentialMode?: boolean;
  confidentialFlags?: string[];
}

export interface ChainMeta {
  name: string;
  selector: string;
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
  executionMode: ExecutionMode;
  token: string;
  amount: string;
  action: string;
  recipient: string;
  receiverContract: string;
  contracts: {
    automatedTrader?: string;
    securityManager?: string;
    tokenVerifier?: string;
    userRecordRegistry?: string;
  };
}

export interface PreflightReport {
  sourceChainSupported: boolean;
  destinationChainSupported: boolean;
  laneEnabled: boolean;
  contractsResolved: boolean;
  tokenMapped: boolean;
  amountParsed: boolean;
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

export interface AIDecision {
  action: DecisionAction;
  confidence: number;
  reason: string;
  operatorMessage: string;
}

export interface AutoPilotOutcome {
  requestId: string;
  timestamp: string;
  status: ResolutionState | "EXECUTION_SUBMITTED";
  resolver: ResolvedExecutionConfig;
  preflight: PreflightReport;
  security: SecurityDecision;
  decision: AIDecision;
  decisionSource?: "OPENAI" | "FALLBACK_POLICY";
  records: WorkflowRecord[];
  execution: {
    submitted: boolean;
    message: string;
    reasonCode?: string;
    txHash?: string;
  };
  confidential?: {
    mode: "CONFIDENTIAL" | "PUBLIC";
    enabled: boolean;
    provider: string;
    flags: string[];
  };
  notifications?: string[];
}

export interface AutoPilotConfig {
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
  automatedTraderByChainId: Record<string, string>;
  securityManagerContract?: string;
  tokenVerifierContract?: string;
  userRecordRegistryContract?: string;
  sourceChainWriteGasLimit?: string;
  decisionMode: DecisionMode;
  openaiFailurePolicy?: OpenAIFailurePolicy;
  executeSafeMaxAmountWei?: string;
  allowCreateOrderFromWorkflow: boolean;
  allowPerformUpkeepFromWorkflow: boolean;
  emitStructuredLogs?: boolean;
  requiredCreCliVersion?: string;
  notificationsEnabled: boolean;
  openaiModel: string;
  openaiApiKey?: string;
  lowFundsWarningThreshold: number;
  confidentialCompute?: {
    enabledByDefault?: boolean;
    strict?: boolean;
    provider?: string;
    tokenApiBaseUrl?: string;
    hideSenderDefault?: boolean;
  };
  chainResolver: {
    enabled: boolean;
    registryAddressByChainId: Record<string, string>;
    chainSelectorByChainId: Record<string, string>;
    mode: "onchain";
    cacheTtlMs: number;
    strict: boolean;
  };
  cronRequest?: AutoPilotRequest;
}
