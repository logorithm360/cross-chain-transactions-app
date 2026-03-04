export type ResolutionState = "READY" | "BLOCKED" | "DEGRADED";

export type BlockedReason =
  | "CHAIN_UNSUPPORTED"
  | "LANE_DISABLED"
  | "CONTRACT_NOT_DEPLOYED"
  | "TOKEN_MAPPING_MISSING"
  | "SECURITY_BLOCKED"
  | "FEE_ESTIMATION_FAILED"
  | "FINALITY_DELAYED";

export interface ResolveRequest {
  walletChainId: number;
  destinationChainId: number;
  serviceType: string;
  token: string;
  amount: string;
  action: string;
  recipient: string;
}

export interface ChainResolverSettings {
  enabled: boolean;
  registryAddressByChainId: Record<string, string>;
  chainSelectorByChainId: Record<string, string>;
  chainNameByChainId?: Record<string, string>;
  mode: "onchain";
  cacheTtlMs: number;
  strict: boolean;
}

export interface ChainResolverRuntimeConfig {
  chainResolver: ChainResolverSettings;
  securityManagerContract?: string;
  tokenVerifierContract?: string;
  userRecordRegistryContract?: string;
}

export interface ResolvedContracts {
  sourceSender?: string;
  destinationReceiver?: string;
  automatedTrader?: string;
  securityManager?: string;
  tokenVerifier?: string;
  userRecordRegistry?: string;
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
  contracts: ResolvedContracts;
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
