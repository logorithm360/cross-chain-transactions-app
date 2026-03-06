export type Feature4AlertType =
  | "PORTFOLIO_DROP_PERCENT"
  | "PORTFOLIO_DROP_ABSOLUTE"
  | "TOKEN_CONCENTRATION"
  | "TOKEN_FLAGGED_SUSPICIOUS"
  | "TOKEN_PRICE_SPIKE"
  | "TOKEN_LIQUIDITY_DROP"
  | "TOKEN_HOLDER_CONCENTRATION"
  | "DCA_ORDER_FAILED"
  | "DCA_LOW_FUNDS"
  | "DCA_ORDER_PAUSED_BY_AI"
  | "DCA_EXECUTION_STUCK"
  | "WALLET_LARGE_OUTFLOW"
  | "WALLET_INTERACTION_WITH_FLAGGED"
  | "WALLET_NEW_TOKEN_RECEIVED";

export type Feature4OpsAction = "UPSERT_RULE" | "ENABLE_RULE" | "LIST_RULES" | "RUN_EVALUATION_ONCE";

export interface Feature4RuleOnchain {
  ruleId: number;
  owner: string;
  alertTypeIndex: number;
  alertType: Feature4AlertType;
  enabled: boolean;
  cooldownSeconds: number;
  rearmSeconds: number;
  paramsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface Feature4StateOnchain {
  active: boolean;
  lastCheckedAt: number;
  lastTriggeredAt: number;
  lastResolvedAt: number;
  lastMetric: string;
  lastFingerprint: string;
  triggerCount: number;
}

export interface Feature4RuleEvalResult {
  conditionMet: boolean;
  metric: string;
  fingerprint: string;
  reason: string;
  details: Record<string, unknown>;
}

export interface Feature4AIContext {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  confidence: number;
  summary: string;
  recommendation: string;
  model: string;
  source: "OPENAI" | "FALLBACK";
  reasonCode?: string;
}

export interface Feature4RuleEvaluationOutcome {
  chainId: number;
  ruleId: number;
  alertType: Feature4AlertType;
  owner: string;
  conditionMet: boolean;
  triggered: boolean;
  resolved: boolean;
  metric: string;
  fingerprint: string;
  reason: string;
  details: Record<string, unknown>;
  aiContext?: Feature4AIContext;
}

export interface Feature4EvaluationSummary {
  evaluated: number;
  triggered: number;
  resolved: number;
  suppressedOrNoop: number;
  outcomes: Feature4RuleEvaluationOutcome[];
}

export interface Feature4HttpRequest {
  action: Feature4OpsAction;
  payload?: Record<string, unknown>;
}

export interface Feature4Config {
  serviceName: string;
  schedule: string;
  authorizedEVMAddresses?: string[];
  emitStructuredLogs?: boolean;
  notificationsEnabled: boolean;
  sourceChainWriteGasLimit?: string;
  feature5Enabled: boolean;
  feature6Enabled: boolean;
  securityEnforcementMode: "MONITOR" | "ENFORCE";
  openaiModel: string;
  openaiApiKey?: string;
  etherscanApiKey?: string;
  dexScreenerApiBaseUrl?: string;
  etherscanApiBaseUrl?: string;
  alertRegistryByChainId: Record<string, string>;
  chainSelectorByChainId: Record<string, string>;
  automatedTraderByChainId: Record<string, string>;
  tokenVerifierByChainId: Record<string, string>;
  securityManagerByChainId?: Record<string, string>;
  userRecordRegistryByChainId?: Record<string, string>;
  monitoredUsers: string[];
  monitoredTokens: string[];
  monitoredWallets: string[];
  cronRun?: {
    chainId: number;
    user?: string;
    ruleId?: number;
  };
}

export interface Feature4OpenAIAlertInput {
  alertType: Feature4AlertType;
  owner: string;
  reason: string;
  metric: string;
  details: Record<string, unknown>;
}
