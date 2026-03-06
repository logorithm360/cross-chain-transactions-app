import {
  bytesToHex,
  cre,
  decodeJson,
  encodeCallMsg,
  LATEST_BLOCK_NUMBER,
  prepareReportRequest,
  Runner,
  type Workflow,
  type HTTPPayload,
  type Runtime
} from "@chainlink/cre-sdk";
import {decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Hex} from "viem";
import type {
  Feature4AlertType,
  Feature4Config,
  Feature4EvaluationSummary,
  Feature4HttpRequest,
  Feature4RuleEvalResult,
  Feature4RuleEvaluationOutcome,
  Feature4RuleOnchain,
  Feature4StateOnchain
} from "./chainAlert.intelligence.types";
import {analyzeAlertWithOpenAI} from "./chainAlert.openai";
import {evaluatePortfolioCategory} from "./chainAlert.eval.portfolio";
import {evaluateTokenCategory, type TokenMarketSnapshot} from "./chainAlert.eval.token";
import {evaluateDcaCategory, type DcaOrderSnapshot} from "./chainAlert.eval.dca";
import {evaluateWalletCategory, type WalletTransfer} from "./chainAlert.eval.wallet";
import {
  boolFrom,
  deterministicFingerprint,
  httpGetJson,
  isAddress,
  normalizeAddress,
  numberFrom,
  parseRuleParams,
  readSecretCompat,
  stringArrayFrom,
  stringFrom
} from "./chainAlert.eval.shared";

const ALERT_TYPES: Feature4AlertType[] = [
  "PORTFOLIO_DROP_PERCENT",
  "PORTFOLIO_DROP_ABSOLUTE",
  "TOKEN_CONCENTRATION",
  "TOKEN_FLAGGED_SUSPICIOUS",
  "TOKEN_PRICE_SPIKE",
  "TOKEN_LIQUIDITY_DROP",
  "TOKEN_HOLDER_CONCENTRATION",
  "DCA_ORDER_FAILED",
  "DCA_LOW_FUNDS",
  "DCA_ORDER_PAUSED_BY_AI",
  "DCA_EXECUTION_STUCK",
  "WALLET_LARGE_OUTFLOW",
  "WALLET_INTERACTION_WITH_FLAGGED",
  "WALLET_NEW_TOKEN_RECEIVED"
];

const DCA_ALERTS = new Set<Feature4AlertType>([
  "DCA_ORDER_FAILED",
  "DCA_LOW_FUNDS",
  "DCA_ORDER_PAUSED_BY_AI",
  "DCA_EXECUTION_STUCK"
]);

const SECURITY_ESCALATION_ALERTS = new Set<Feature4AlertType>([
  "TOKEN_FLAGGED_SUSPICIOUS",
  "DCA_ORDER_FAILED",
  "DCA_EXECUTION_STUCK",
  "WALLET_INTERACTION_WITH_FLAGGED"
]);

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

const alertRegistryAbi = [
  {
    type: "function",
    name: "getUserRuleIds",
    stateMutability: "view",
    inputs: [{name: "_owner", type: "address"}],
    outputs: [{name: "", type: "uint256[]"}]
  },
  {
    type: "function",
    name: "getRule",
    stateMutability: "view",
    inputs: [{name: "_ruleId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "ruleId", type: "uint256"},
          {name: "owner", type: "address"},
          {name: "alertType", type: "uint8"},
          {name: "enabled", type: "bool"},
          {name: "cooldownSeconds", type: "uint32"},
          {name: "rearmSeconds", type: "uint32"},
          {name: "paramsJson", type: "string"},
          {name: "createdAt", type: "uint64"},
          {name: "updatedAt", type: "uint64"}
        ]
      }
    ]
  },
  {
    type: "function",
    name: "getRuleState",
    stateMutability: "view",
    inputs: [{name: "_ruleId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "active", type: "bool"},
          {name: "lastCheckedAt", type: "uint64"},
          {name: "lastTriggeredAt", type: "uint64"},
          {name: "lastResolvedAt", type: "uint64"},
          {name: "lastMetric", type: "int256"},
          {name: "lastFingerprint", type: "bytes32"},
          {name: "triggerCount", type: "uint32"}
        ]
      }
    ]
  },
  {
    type: "function",
    name: "upsertRule",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_ruleId", type: "uint256"},
      {name: "_alertType", type: "uint8"},
      {name: "_enabled", type: "bool"},
      {name: "_cooldownSeconds", type: "uint32"},
      {name: "_rearmSeconds", type: "uint32"},
      {name: "_paramsJson", type: "string"}
    ],
    outputs: [{name: "ruleId", type: "uint256"}]
  },
  {
    type: "function",
    name: "setRuleEnabled",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_ruleId", type: "uint256"},
      {name: "_enabled", type: "bool"}
    ],
    outputs: []
  },
  {
    type: "function",
    name: "recordEvaluation",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_ruleId", type: "uint256"},
      {name: "_metric", type: "int256"},
      {name: "_fingerprint", type: "bytes32"},
      {name: "_conditionMet", type: "bool"},
      {name: "_note", type: "string"}
    ],
    outputs: []
  },
  {
    type: "function",
    name: "recordTrigger",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_ruleId", type: "uint256"},
      {name: "_metric", type: "int256"},
      {name: "_fingerprint", type: "bytes32"},
      {name: "_reason", type: "string"}
    ],
    outputs: [{name: "triggered", type: "bool"}]
  },
  {
    type: "function",
    name: "recordResolve",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_ruleId", type: "uint256"},
      {name: "_metric", type: "int256"},
      {name: "_fingerprint", type: "bytes32"},
      {name: "_reason", type: "string"}
    ],
    outputs: [{name: "resolved", type: "bool"}]
  }
] as const;

const automatedTraderAbi = [
  {
    type: "function",
    name: "getOrderSnapshot",
    stateMutability: "view",
    inputs: [{name: "_orderId", type: "uint256"}],
    outputs: [
      {
        type: "tuple",
        components: [
          {name: "orderId", type: "uint256"},
          {name: "owner", type: "address"},
          {name: "triggerType", type: "uint8"},
          {name: "dcaStatus", type: "uint8"},
          {name: "isReadyToExecute", type: "bool"},
          {name: "isFunded", type: "bool"},
          {name: "estimatedFeePerExecution", type: "uint256"},
          {name: "executionsRemainingFunded", type: "uint256"},
          {name: "token", type: "address"},
          {name: "amount", type: "uint256"},
          {name: "destinationChain", type: "uint64"},
          {name: "recipient", type: "address"},
          {name: "action", type: "string"},
          {name: "interval", type: "uint256"},
          {name: "createdAt", type: "uint256"},
          {name: "lastExecutedAt", type: "uint256"},
          {name: "nextExecutionAt", type: "uint256"},
          {name: "deadline", type: "uint256"},
          {name: "executionCount", type: "uint256"},
          {name: "maxExecutions", type: "uint256"},
          {name: "recurring", type: "bool"},
          {name: "contractLinkBalance", type: "uint256"},
          {name: "contractTokenBalance", type: "uint256"},
          {name: "lastPendingMessageIds", type: "bytes32[3]"},
          {name: "lastCompletedMessageIds", type: "bytes32[3]"},
          {name: "lastFailedMessageIds", type: "bytes32[3]"}
        ]
      }
    ]
  }
] as const;

const tokenVerifierAbi = [
  {
    type: "function",
    name: "getStatus",
    stateMutability: "view",
    inputs: [{name: "_token", type: "address"}],
    outputs: [{name: "", type: "uint8"}]
  }
] as const;

const userRecordRegistryAbi = [
  {
    type: "function",
    name: "appendRecord",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "input",
        type: "tuple",
        components: [
          {name: "user", type: "address"},
          {name: "featureType", type: "uint8"},
          {name: "chainSelector", type: "uint64"},
          {name: "sourceContract", type: "address"},
          {name: "counterparty", type: "address"},
          {name: "messageId", type: "bytes32"},
          {name: "assetToken", type: "address"},
          {name: "amount", type: "uint256"},
          {name: "actionHash", type: "bytes32"},
          {name: "status", type: "uint8"},
          {name: "metadataHash", type: "bytes32"}
        ]
      },
      {name: "externalEventKey", type: "bytes32"}
    ],
    outputs: [{name: "recordId", type: "uint256"}]
  }
] as const;

const securityManagerAbi = [
  {
    type: "function",
    name: "logIncident",
    stateMutability: "nonpayable",
    inputs: [
      {name: "_actor", type: "address"},
      {name: "_feature", type: "uint8"},
      {name: "_reason", type: "bytes32"},
      {name: "_ref", type: "bytes32"}
    ],
    outputs: []
  }
] as const;

function validateRuntimeConfig(config: Feature4Config): void {
  if (!config.schedule || config.schedule.trim().length === 0) {
    throw new Error("Invalid config: schedule is required");
  }
  if (!config.openaiModel || config.openaiModel.trim().length === 0) {
    throw new Error("Invalid config: openaiModel is required");
  }
  if (Object.keys(config.alertRegistryByChainId).length === 0) {
    throw new Error("Invalid config: alertRegistryByChainId is required");
  }
  if (config.feature5Enabled) {
    const hasAnyRegistry = Object.values(config.userRecordRegistryByChainId ?? {}).some((x) => isAddress(x));
    if (!hasAnyRegistry) {
      throw new Error("Invalid config: feature5Enabled requires userRecordRegistryByChainId");
    }
  }
  if (config.feature6Enabled) {
    const hasAnySecurityManager = Object.values(config.securityManagerByChainId ?? {}).some((x) => isAddress(x));
    if (!hasAnySecurityManager) {
      throw new Error("Invalid config: feature6Enabled requires securityManagerByChainId");
    }
  }
}

function emitOpsLog(runtime: Runtime<Feature4Config>, event: string, payload: Record<string, unknown>): void {
  if (!runtime.config.emitStructuredLogs) return;
  runtime.log(`[ops] ${JSON.stringify({service: "CHAINALERT_INTELLIGENCE", event, ...payload})}`);
}

function deterministicRequestId(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) hash = (hash * 33 + input.charCodeAt(i)) >>> 0;
  return `f4_${hash.toString(16).padStart(8, "0")}`;
}

function toAlertTypeByIndex(index: number): Feature4AlertType {
  return ALERT_TYPES[index] ?? "DCA_ORDER_FAILED";
}

function toAlertTypeIndex(type: string): number {
  const idx = ALERT_TYPES.indexOf(type as Feature4AlertType);
  if (idx < 0) throw new Error(`Unsupported alertType: ${type}`);
  return idx;
}

type DecodedRule = {
  ruleId: bigint;
  owner: string;
  alertType: number;
  enabled: boolean;
  cooldownSeconds: number;
  rearmSeconds: number;
  paramsJson: string;
  createdAt: bigint;
  updatedAt: bigint;
};

type DecodedState = {
  active: boolean;
  lastCheckedAt: bigint;
  lastTriggeredAt: bigint;
  lastResolvedAt: bigint;
  lastMetric: bigint;
  lastFingerprint: Hex;
  triggerCount: number;
};

type DecodedOrderSnapshot = {
  orderId: bigint;
  dcaStatus: number;
  executionsRemainingFunded: bigint;
  lastPendingMessageIds: readonly Hex[];
  lastFailedMessageIds: readonly Hex[];
  lastExecutedAt: bigint;
};

function parseRule(decoded: DecodedRule): Feature4RuleOnchain {
  const typeIndex = Number(decoded.alertType);
  return {
    ruleId: Number(decoded.ruleId),
    owner: decoded.owner,
    alertTypeIndex: typeIndex,
    alertType: toAlertTypeByIndex(typeIndex),
    enabled: decoded.enabled,
    cooldownSeconds: Number(decoded.cooldownSeconds),
    rearmSeconds: Number(decoded.rearmSeconds),
    paramsJson: decoded.paramsJson,
    createdAt: Number(decoded.createdAt),
    updatedAt: Number(decoded.updatedAt)
  };
}

function parseState(decoded: DecodedState): Feature4StateOnchain {
  return {
    active: decoded.active,
    lastCheckedAt: Number(decoded.lastCheckedAt),
    lastTriggeredAt: Number(decoded.lastTriggeredAt),
    lastResolvedAt: Number(decoded.lastResolvedAt),
    lastMetric: decoded.lastMetric.toString(),
    lastFingerprint: decoded.lastFingerprint,
    triggerCount: Number(decoded.triggerCount)
  };
}

function metricToInt(metric: string): bigint {
  const n = Number(metric);
  if (!Number.isFinite(n)) return BigInt(0);
  return BigInt(Math.trunc(n * 1_000_000));
}

function chainSelectorFor(config: Feature4Config, chainId: number): bigint {
  const value = config.chainSelectorByChainId[String(chainId)];
  if (!value) throw new Error(`Missing chainSelectorByChainId for chainId=${chainId}`);
  return BigInt(value);
}

function registryFor(config: Feature4Config, chainId: number): string {
  const addr = config.alertRegistryByChainId[String(chainId)] ?? "";
  if (!isAddress(addr)) throw new Error(`Invalid alert registry address for chainId=${chainId}`);
  return addr;
}

function userRecordRegistryFor(config: Feature4Config, chainId: number): string | undefined {
  const addr = config.userRecordRegistryByChainId?.[String(chainId)] ?? "";
  return isAddress(addr) ? addr : undefined;
}

function securityManagerFor(config: Feature4Config, chainId: number): string | undefined {
  const addr = config.securityManagerByChainId?.[String(chainId)] ?? "";
  return isAddress(addr) ? addr : undefined;
}

function isBytes32Hex(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function callView(
  runtime: Runtime<Feature4Config>,
  chainId: number,
  to: string,
  data: Hex
): Hex {
  const selector = chainSelectorFor(runtime.config, chainId);
  const evm = new cre.capabilities.EVMClient(selector);
  const out = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: to as `0x${string}`,
        to: to as `0x${string}`,
        data
      }),
      blockNumber: LATEST_BLOCK_NUMBER
    })
    .result();
  return bytesToHex(out.data);
}

function writeContract(
  runtime: Runtime<Feature4Config>,
  chainId: number,
  receiver: string,
  data: Hex
): {submitted: boolean; txHash?: string; error?: string} {
  try {
    const selector = chainSelectorFor(runtime.config, chainId);
    const evm = new cre.capabilities.EVMClient(selector);
    const report = runtime.report(prepareReportRequest(data)).result();
    const write = evm
      .writeReport(runtime, {
        receiver: receiver as `0x${string}`,
        report,
        gasConfig: {gasLimit: runtime.config.sourceChainWriteGasLimit ?? "1000000"}
      })
      .result();

    const txHash = write.txHash && write.txHash.length > 0 ? bytesToHex(write.txHash) : undefined;
    return {submitted: true, txHash};
  } catch (error) {
    return {submitted: false, error: error instanceof Error ? error.message : String(error)};
  }
}

function readUserRuleIds(runtime: Runtime<Feature4Config>, chainId: number, registry: string, user: string): number[] {
  const calldata = encodeFunctionData({
    abi: alertRegistryAbi,
    functionName: "getUserRuleIds",
    args: [user as `0x${string}`]
  });
  const out = callView(runtime, chainId, registry, calldata);
  const decoded = decodeFunctionResult({
    abi: alertRegistryAbi,
    functionName: "getUserRuleIds",
    data: out
  }) as readonly bigint[];
  return decoded.map((x) => Number(x));
}

function readRule(runtime: Runtime<Feature4Config>, chainId: number, registry: string, ruleId: number): Feature4RuleOnchain {
  const calldata = encodeFunctionData({
    abi: alertRegistryAbi,
    functionName: "getRule",
    args: [BigInt(ruleId)]
  });
  const out = callView(runtime, chainId, registry, calldata);
  const decoded = decodeFunctionResult({
    abi: alertRegistryAbi,
    functionName: "getRule",
    data: out
  }) as unknown as DecodedRule;
  return parseRule(decoded);
}

function readState(runtime: Runtime<Feature4Config>, chainId: number, registry: string, ruleId: number): Feature4StateOnchain {
  const calldata = encodeFunctionData({
    abi: alertRegistryAbi,
    functionName: "getRuleState",
    args: [BigInt(ruleId)]
  });
  const out = callView(runtime, chainId, registry, calldata);
  const decoded = decodeFunctionResult({
    abi: alertRegistryAbi,
    functionName: "getRuleState",
    data: out
  }) as unknown as DecodedState;
  return parseState(decoded);
}

function isDcaAlert(type: Feature4AlertType): boolean {
  return DCA_ALERTS.has(type);
}

function parseOrderIds(rule: Feature4RuleOnchain): number[] {
  const params = parseRuleParams(rule.paramsJson);
  const ids = stringArrayFrom(params.orderIds).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x >= 0);
  return ids;
}

function canTriggerNow(rule: Feature4RuleOnchain, state: Feature4StateOnchain, nowTs: number): boolean {
  if (!rule.enabled) return false;
  if (state.active && nowTs < state.lastTriggeredAt + rule.cooldownSeconds) return false;
  if (!state.active && state.lastResolvedAt > 0 && nowTs < state.lastResolvedAt + rule.rearmSeconds) return false;
  return true;
}

function parseOrderSnapshot(decoded: DecodedOrderSnapshot): DcaOrderSnapshot {
  return {
    orderId: Number(decoded.orderId),
    dcaStatus: Number(decoded.dcaStatus),
    executionsRemainingFunded: Number(decoded.executionsRemainingFunded),
    lastPendingMessageIds: decoded.lastPendingMessageIds.map((x) => String(x)),
    lastFailedMessageIds: decoded.lastFailedMessageIds.map((x) => String(x)),
    lastExecutedAt: Number(decoded.lastExecutedAt)
  };
}

function mapRecordStatusForOutcome(outcome: Feature4RuleEvaluationOutcome): number {
  if (outcome.triggered) return 4; // PENDING_ACTION
  if (outcome.resolved) return 7; // RECOVERED
  return 0; // CREATED
}

function shouldLogSecurityIncident(outcome: Feature4RuleEvaluationOutcome): boolean {
  if (!outcome.triggered) return false;
  if (SECURITY_ESCALATION_ALERTS.has(outcome.alertType)) return true;
  if (outcome.aiContext?.severity === "HIGH" || outcome.aiContext?.severity === "CRITICAL") return true;
  return false;
}

function appendOutcomeRecordOnchain(
  runtime: Runtime<Feature4Config>,
  chainId: number,
  outcome: Feature4RuleEvaluationOutcome,
  runKey: string
): void {
  if (!runtime.config.feature5Enabled) return;

  const recordRegistry = userRecordRegistryFor(runtime.config, chainId);
  if (!recordRegistry) return;
  if (!isAddress(outcome.owner)) return;

  const sourceContract = registryFor(runtime.config, chainId);
  const counterparty = runtime.config.automatedTraderByChainId[String(chainId)] ?? sourceContract;
  const tokenCandidate = String(outcome.details.token ?? runtime.config.monitoredTokens[0] ?? "");
  const assetToken = isAddress(tokenCandidate) ? tokenCandidate : "0x0000000000000000000000000000000000000000";

  const phase = outcome.triggered ? "ALERT_TRIGGERED" : outcome.resolved ? "ALERT_RESOLVED" : "ALERT_EVALUATED";
  const metadataHash = keccak256(toBytes(JSON.stringify({
    alertType: outcome.alertType,
    reason: outcome.reason,
    metric: outcome.metric,
    details: outcome.details
  })));
  const actionHash = keccak256(toBytes(`CHAINALERT:${phase}:${outcome.alertType}`));
  const messageId = isBytes32Hex(outcome.fingerprint) ? (outcome.fingerprint as Hex) : (ZERO_BYTES32 as Hex);
  const externalEventKey = keccak256(
    toBytes(`${runKey}:${chainId}:${outcome.ruleId}:${phase}:${outcome.fingerprint}:${outcome.triggered}:${outcome.resolved}`)
  );

  const calldata = encodeFunctionData({
    abi: userRecordRegistryAbi,
    functionName: "appendRecord",
    args: [
      {
        user: outcome.owner as `0x${string}`,
        featureType: 3, // AUTOMATED_TRADER
        chainSelector: chainSelectorFor(runtime.config, chainId),
        sourceContract: sourceContract as `0x${string}`,
        counterparty: (isAddress(counterparty) ? counterparty : sourceContract) as `0x${string}`,
        messageId,
        assetToken: assetToken as `0x${string}`,
        amount: BigInt(0),
        actionHash,
        status: mapRecordStatusForOutcome(outcome),
        metadataHash
      },
      externalEventKey
    ]
  });

  const write = writeContract(runtime, chainId, recordRegistry, calldata);
  if (!write.submitted) {
    emitOpsLog(runtime, "feature5_append_record_failed", {
      chainId,
      ruleId: outcome.ruleId,
      owner: outcome.owner,
      phase,
      error: write.error ?? "unknown"
    });
  }
}

function logSecurityIncidentOnchain(
  runtime: Runtime<Feature4Config>,
  chainId: number,
  outcome: Feature4RuleEvaluationOutcome
): void {
  if (!runtime.config.feature6Enabled) return;
  if (!shouldLogSecurityIncident(outcome)) return;

  const securityManager = securityManagerFor(runtime.config, chainId);
  if (!securityManager) return;
  if (!isAddress(outcome.owner)) return;

  const reasonHash = keccak256(toBytes(`CHAINALERT:${outcome.alertType}:${outcome.reason}`));
  const refHash = isBytes32Hex(outcome.fingerprint) ? (outcome.fingerprint as Hex) : keccak256(toBytes(outcome.fingerprint));
  const calldata = encodeFunctionData({
    abi: securityManagerAbi,
    functionName: "logIncident",
    args: [
      outcome.owner as `0x${string}`,
      3, // FeatureId.AUTOMATED_TRADER
      reasonHash,
      refHash
    ]
  });

  const write = writeContract(runtime, chainId, securityManager, calldata);
  if (!write.submitted) {
    emitOpsLog(runtime, "feature6_log_incident_failed", {
      chainId,
      ruleId: outcome.ruleId,
      owner: outcome.owner,
      alertType: outcome.alertType,
      error: write.error ?? "unknown"
    });
  }
}

function fetchTokenMarket(
  runtime: Runtime<Feature4Config>,
  token: string,
  cache: Map<string, TokenMarketSnapshot>
): TokenMarketSnapshot | undefined {
  const key = normalizeAddress(token);
  if (cache.has(key)) return cache.get(key);

  const base = runtime.config.dexScreenerApiBaseUrl ?? "https://api.dexscreener.com/latest/dex/tokens";
  const url = `${base}/${key}`;
  const payload = httpGetJson(runtime, url);

  if (!payload) {
    cache.set(key, {});
    return cache.get(key);
  }

  const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
  const first = (pairs[0] ?? {}) as Record<string, unknown>;
  const priceChange = (first.priceChange ?? {}) as Record<string, unknown>;
  const liquidity = (first.liquidity ?? {}) as Record<string, unknown>;

  const snapshot: TokenMarketSnapshot = {
    priceUsd: numberFrom(first.priceUsd, 0),
    priceChangePct1h: numberFrom(priceChange.h1, 0),
    liquidityUsd: numberFrom(liquidity.usd, 0)
  };

  cache.set(key, snapshot);
  return snapshot;
}

function fetchWalletTransfers(
  runtime: Runtime<Feature4Config>,
  wallet: string,
  lookbackMinutes: number,
  cache: Map<string, WalletTransfer[]>
): WalletTransfer[] {
  const norm = normalizeAddress(wallet);
  const key = `${norm}:${lookbackMinutes}`;
  if (cache.has(key)) return cache.get(key) ?? [];

  const apiKey =
    readSecretCompat(runtime as unknown as {getSecret: (request: unknown) => {result: () => {value?: string}}}, "ETHERSCAN_API_KEY") ||
    String(runtime.config.etherscanApiKey ?? "").trim();

  const base = runtime.config.etherscanApiBaseUrl ?? "https://api-sepolia.etherscan.io/api";
  const url = `${base}?module=account&action=tokentx&address=${norm}&sort=desc&page=1&offset=100${
    apiKey ? `&apikey=${apiKey}` : ""
  }`;

  const payload = httpGetJson(runtime, url);
  if (!payload || !Array.isArray(payload.result)) {
    cache.set(key, []);
    return [];
  }

  const nowTs = Math.floor(runtime.now().getTime() / 1000);
  const cutoff = nowTs - lookbackMinutes * 60;
  const transfers: WalletTransfer[] = [];

  for (const row of payload.result) {
    if (typeof row !== "object" || row === null) continue;
    const tx = row as Record<string, unknown>;
    const ts = numberFrom(tx.timeStamp, 0);
    if (ts < cutoff) continue;

    transfers.push({
      from: String(tx.from ?? ""),
      to: String(tx.to ?? ""),
      contractAddress: String(tx.contractAddress ?? ""),
      value: String(tx.value ?? "0"),
      tokenDecimal: String(tx.tokenDecimal ?? "18"),
      timeStamp: String(tx.timeStamp ?? "0")
    });
  }

  cache.set(key, transfers);
  return transfers;
}

function evaluateRule(
  runtime: Runtime<Feature4Config>,
  chainId: number,
  rule: Feature4RuleOnchain,
  caches: {
    tokenMarket: Map<string, TokenMarketSnapshot>;
    tokenStatus: Map<string, number>;
    walletTransfers: Map<string, WalletTransfer[]>;
    dcaOrders: Map<number, DcaOrderSnapshot>;
  }
): Feature4RuleEvalResult {
  const registry = registryFor(runtime.config, chainId);
  const tokenVerifier = runtime.config.tokenVerifierByChainId[String(chainId)] ?? "";
  const trader = runtime.config.automatedTraderByChainId[String(chainId)] ?? "";

  const tokenMarketLookup = (token: string): TokenMarketSnapshot | undefined => {
    return fetchTokenMarket(runtime, token, caches.tokenMarket);
  };

  const tokenPriceLookup = (token: string): number | undefined => {
    return tokenMarketLookup(token)?.priceUsd;
  };

  const tokenStatusLookup = (token: string): number | undefined => {
    const key = normalizeAddress(token);
    if (caches.tokenStatus.has(key)) return caches.tokenStatus.get(key);

    if (!isAddress(tokenVerifier)) {
      caches.tokenStatus.set(key, 0);
      return 0;
    }

    try {
      const calldata = encodeFunctionData({
        abi: tokenVerifierAbi,
        functionName: "getStatus",
        args: [key as `0x${string}`]
      });
      const out = callView(runtime, chainId, tokenVerifier, calldata);
      const decoded = decodeFunctionResult({
        abi: tokenVerifierAbi,
        functionName: "getStatus",
        data: out
      }) as number;
      caches.tokenStatus.set(key, Number(decoded));
      return Number(decoded);
    } catch {
      caches.tokenStatus.set(key, 0);
      return 0;
    }
  };

  const walletTransfersLookup = (wallet: string, lookbackMinutes: number): WalletTransfer[] => {
    return fetchWalletTransfers(runtime, wallet, lookbackMinutes, caches.walletTransfers);
  };

  const dcaLookup = (orderId: number): DcaOrderSnapshot | undefined => {
    if (caches.dcaOrders.has(orderId)) return caches.dcaOrders.get(orderId);
    if (!isAddress(trader)) return undefined;

    try {
      const calldata = encodeFunctionData({
        abi: automatedTraderAbi,
        functionName: "getOrderSnapshot",
        args: [BigInt(orderId)]
      });
      const out = callView(runtime, chainId, trader, calldata);
      const decoded = decodeFunctionResult({
        abi: automatedTraderAbi,
        functionName: "getOrderSnapshot",
        data: out
      }) as unknown as DecodedOrderSnapshot;
      const parsed = parseOrderSnapshot(decoded);
      caches.dcaOrders.set(orderId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  };

  const nowTs = Math.floor(runtime.now().getTime() / 1000);

  const portfolio = evaluatePortfolioCategory(rule.alertType, rule, tokenPriceLookup);
  if (portfolio) return portfolio;

  const token = evaluateTokenCategory(rule.alertType, rule, {tokenStatusLookup, tokenMarketLookup});
  if (token) return token;

  const dca = evaluateDcaCategory(rule.alertType, rule, {dcaLookup, nowTs});
  if (dca) return dca;

  const wallet = evaluateWalletCategory(rule.alertType, rule, {walletTransfersLookup, tokenPriceLookup});
  if (wallet) return wallet;

  return {
    conditionMet: false,
    metric: "0",
    fingerprint: deterministicFingerprint([rule.ruleId, "unsupported", rule.alertType]),
    reason: "UNSUPPORTED_ALERT_TYPE",
    details: {alertType: rule.alertType, registry}
  };
}

function runEvaluation(
  runtime: Runtime<Feature4Config>,
  options: {
    chainId?: number;
    user?: string;
    ruleId?: number;
    dcaOrderId?: number;
    runKey?: string;
    triggerSource: "CRON" | "HTTP" | "EVM_LOG";
  }
): Feature4EvaluationSummary {
  const chainIds = options.chainId
    ? [options.chainId]
    : Object.keys(runtime.config.alertRegistryByChainId).map((x) => Number(x));

  const outcomes: Feature4RuleEvaluationOutcome[] = [];

  for (const chainId of chainIds) {
    const registry = registryFor(runtime.config, chainId);
    const users = options.user ? [options.user] : runtime.config.monitoredUsers;

    const caches = {
      tokenMarket: new Map<string, TokenMarketSnapshot>(),
      tokenStatus: new Map<string, number>(),
      walletTransfers: new Map<string, WalletTransfer[]>(),
      dcaOrders: new Map<number, DcaOrderSnapshot>()
    };

    for (const user of users) {
      if (!isAddress(user)) continue;

      let ruleIds: number[] = [];
      try {
        ruleIds = readUserRuleIds(runtime, chainId, registry, user);
      } catch {
        continue;
      }

      for (const ruleId of ruleIds) {
        if (options.ruleId && ruleId !== options.ruleId) continue;

        let rule: Feature4RuleOnchain;
        let state: Feature4StateOnchain;

        try {
          rule = readRule(runtime, chainId, registry, ruleId);
          state = readState(runtime, chainId, registry, ruleId);
        } catch {
          continue;
        }

        if (rule.owner.toLowerCase() !== user.toLowerCase()) continue;

        if (typeof options.dcaOrderId === "number") {
          if (!isDcaAlert(rule.alertType)) continue;
          const orderIds = parseOrderIds(rule);
          if (orderIds.length > 0 && !orderIds.includes(options.dcaOrderId)) continue;
        }

        const evalResult = evaluateRule(runtime, chainId, rule, caches);
        const metricInt = metricToInt(evalResult.metric);

        // Always store heartbeat evaluation state first.
        const evalCalldata = encodeFunctionData({
          abi: alertRegistryAbi,
          functionName: "recordEvaluation",
          args: [BigInt(ruleId), metricInt, evalResult.fingerprint as Hex, evalResult.conditionMet, evalResult.reason]
        });
        const evalWrite = writeContract(runtime, chainId, registry, evalCalldata);
        if (!evalWrite.submitted) {
          emitOpsLog(runtime, "record_evaluation_failed", {
            chainId,
            ruleId,
            error: evalWrite.error ?? "unknown"
          });
        }

        const nowTs = Math.floor(runtime.now().getTime() / 1000);
        const predictedTrigger = evalResult.conditionMet && canTriggerNow(rule, state, nowTs);
        let triggered = false;
        let resolved = false;
        let aiContext: Feature4RuleEvaluationOutcome["aiContext"];

        if (evalResult.conditionMet) {
          if (predictedTrigger) {
            aiContext = analyzeAlertWithOpenAI(runtime, {
              alertType: rule.alertType,
              owner: rule.owner,
              reason: evalResult.reason,
              metric: evalResult.metric,
              details: evalResult.details
            });
            triggered = true;
          }

          const triggerCalldata = encodeFunctionData({
            abi: alertRegistryAbi,
            functionName: "recordTrigger",
            args: [BigInt(ruleId), metricInt, evalResult.fingerprint as Hex, evalResult.reason]
          });
          const triggerWrite = writeContract(runtime, chainId, registry, triggerCalldata);
          if (!triggerWrite.submitted) {
            emitOpsLog(runtime, "record_trigger_failed", {
              chainId,
              ruleId,
              error: triggerWrite.error ?? "unknown"
            });
          }
        } else if (state.active) {
          const resolveCalldata = encodeFunctionData({
            abi: alertRegistryAbi,
            functionName: "recordResolve",
            args: [BigInt(ruleId), metricInt, evalResult.fingerprint as Hex, evalResult.reason]
          });
          const resolveWrite = writeContract(runtime, chainId, registry, resolveCalldata);
          if (resolveWrite.submitted) {
            resolved = true;
          } else {
            emitOpsLog(runtime, "record_resolve_failed", {
              chainId,
              ruleId,
              error: resolveWrite.error ?? "unknown"
            });
          }
        }

        outcomes.push({
          chainId,
          ruleId,
          alertType: rule.alertType,
          owner: rule.owner,
          conditionMet: evalResult.conditionMet,
          triggered,
          resolved,
          metric: evalResult.metric,
          fingerprint: evalResult.fingerprint,
          reason: evalResult.reason,
          details: {
            ...evalResult.details,
            triggerSource: options.triggerSource
          },
          aiContext
        });

        const currentOutcome = outcomes[outcomes.length - 1];
        appendOutcomeRecordOnchain(
          runtime,
          chainId,
          currentOutcome,
          options.runKey ?? `${options.triggerSource}:${runtime.now().toISOString()}`
        );
        logSecurityIncidentOnchain(runtime, chainId, currentOutcome);
      }
    }
  }

  const triggered = outcomes.filter((x) => x.triggered).length;
  const resolved = outcomes.filter((x) => x.resolved).length;

  return {
    evaluated: outcomes.length,
    triggered,
    resolved,
    suppressedOrNoop: outcomes.length - triggered - resolved,
    outcomes
  };
}

function listRules(runtime: Runtime<Feature4Config>, chainId: number, user: string): Record<string, unknown> {
  const registry = registryFor(runtime.config, chainId);
  const ids = readUserRuleIds(runtime, chainId, registry, user);
  const rules: Array<{rule: Feature4RuleOnchain; state: Feature4StateOnchain}> = [];

  for (const id of ids) {
    try {
      rules.push({
        rule: readRule(runtime, chainId, registry, id),
        state: readState(runtime, chainId, registry, id)
      });
    } catch {
      // skip unreadable rule ids
    }
  }

  return {chainId, user, count: rules.length, rules};
}

function handleHttpAction(runtime: Runtime<Feature4Config>, request: Feature4HttpRequest): Record<string, unknown> {
  const payload = request.payload ?? {};

  if (request.action === "UPSERT_RULE") {
    const chainId = numberFrom(payload.chainId, 0);
    const registry = registryFor(runtime.config, chainId);
    const ruleId = numberFrom(payload.ruleId, 0);
    const alertType = String(payload.alertType ?? "");
    const enabled = boolFrom(payload.enabled, true);
    const cooldownSeconds = numberFrom(payload.cooldownSeconds, 300);
    const rearmSeconds = numberFrom(payload.rearmSeconds, 60);
    const params = (payload.params ?? {}) as Record<string, unknown>;

    const calldata = encodeFunctionData({
      abi: alertRegistryAbi,
      functionName: "upsertRule",
      args: [
        BigInt(ruleId),
        toAlertTypeIndex(alertType),
        enabled,
        cooldownSeconds,
        rearmSeconds,
        JSON.stringify(params)
      ]
    });

    const write = writeContract(runtime, chainId, registry, calldata);
    return {
      action: request.action,
      chainId,
      submitted: write.submitted,
      txHash: write.txHash,
      error: write.error
    };
  }

  if (request.action === "ENABLE_RULE") {
    const chainId = numberFrom(payload.chainId, 0);
    const registry = registryFor(runtime.config, chainId);
    const ruleId = numberFrom(payload.ruleId, 0);
    const enabled = boolFrom(payload.enabled, true);

    const calldata = encodeFunctionData({
      abi: alertRegistryAbi,
      functionName: "setRuleEnabled",
      args: [BigInt(ruleId), enabled]
    });

    const write = writeContract(runtime, chainId, registry, calldata);
    return {
      action: request.action,
      chainId,
      ruleId,
      enabled,
      submitted: write.submitted,
      txHash: write.txHash,
      error: write.error
    };
  }

  if (request.action === "LIST_RULES") {
    const chainId = numberFrom(payload.chainId, 0);
    const user = stringFrom(payload.user, runtime.config.monitoredUsers[0] ?? "");
    return {
      action: request.action,
      ...listRules(runtime, chainId, user)
    };
  }

  if (request.action === "RUN_EVALUATION_ONCE") {
    const chainId = numberFrom(payload.chainId, 0) || undefined;
    const user = stringFrom(payload.user, "") || undefined;
    const ruleId = numberFrom(payload.ruleId, 0) || undefined;
    const runKey = String(payload.runKey ?? deterministicRequestId(JSON.stringify(payload)));
    const summary = runEvaluation(runtime, {chainId, user, ruleId, runKey, triggerSource: "HTTP"});
    return {
      action: request.action,
      summary
    };
  }

  throw new Error(`Unsupported action: ${request.action}`);
}

const onHttpFeature4 = (runtime: Runtime<Feature4Config>, payload: HTTPPayload): string => {
  const timestamp = runtime.now().toISOString();

  if (!payload.input || payload.input.length === 0) {
    return JSON.stringify({success: false, timestamp, error: "Empty request body"});
  }

  const raw = new TextDecoder().decode(payload.input);
  const requestId = deterministicRequestId(raw);

  try {
    const request = decodeJson(payload.input) as Feature4HttpRequest;
    const data = handleHttpAction(runtime, request);
    return JSON.stringify({success: true, requestId, timestamp, data});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitOpsLog(runtime, "http_action_error", {requestId, error: message});
    return JSON.stringify({success: false, requestId, timestamp, error: message});
  }
};

const onCronFeature4 = (runtime: Runtime<Feature4Config>): string => {
  const timestamp = runtime.now().toISOString();
  const run = runtime.config.cronRun;
  const runKey = deterministicRequestId(`cron:${timestamp}:${JSON.stringify(run ?? {})}`);
  const summary = runEvaluation(runtime, {
    chainId: run?.chainId,
    user: run?.user,
    ruleId: run?.ruleId,
    runKey,
    triggerSource: "CRON"
  });

  emitOpsLog(runtime, "cron_summary", {
    evaluated: summary.evaluated,
    triggered: summary.triggered,
    resolved: summary.resolved,
    suppressedOrNoop: summary.suppressedOrNoop
  });

  return JSON.stringify({success: true, timestamp, data: summary});
};

function parseOrderIdFromTopic(topic?: Uint8Array): number | undefined {
  if (!topic || topic.length === 0) return undefined;
  try {
    const asBigInt = BigInt(bytesToHex(topic));
    if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(asBigInt);
  } catch {
    return undefined;
  }
}

const onDcaLog = (runtime: Runtime<Feature4Config>, chainId: number, trader: string, logPayload: unknown): string => {
  const timestamp = runtime.now().toISOString();
  const log = logPayload as {topics?: Uint8Array[]; eventSig?: Uint8Array};
  const topics = Array.isArray(log.topics) ? log.topics : [];
  const orderId = parseOrderIdFromTopic(topics[1]);
  const eventSig = log.eventSig ? bytesToHex(log.eventSig) : ZERO_BYTES32;
  const runKey = deterministicRequestId(`evm:${chainId}:${eventSig}:${orderId ?? -1}:${timestamp}`);

  const summary = runEvaluation(runtime, {
    chainId,
    dcaOrderId: orderId,
    runKey,
    triggerSource: "EVM_LOG"
  });

  emitOpsLog(runtime, "dca_log_processed", {
    chainId,
    trader,
    orderId: orderId ?? -1,
    eventSig,
    evaluated: summary.evaluated,
    triggered: summary.triggered
  });

  return JSON.stringify({
    success: true,
    timestamp,
    data: {
      chainId,
      trader,
      orderId,
      eventSig,
      summary
    }
  });
};

function initWorkflow(config: Feature4Config): Workflow<Feature4Config> {
  validateRuntimeConfig(config);

  const handlers: unknown[] = [];

  const cron = new cre.capabilities.CronCapability();
  handlers.push(cre.handler(cron.trigger({schedule: config.schedule}), onCronFeature4));

  const http = new cre.capabilities.HTTPCapability();
  const configuredKeys = (config.authorizedEVMAddresses ?? [])
    .filter((x) => isAddress(x))
    .map((x) => ({type: "KEY_TYPE_ECDSA_EVM" as const, publicKey: x}));
  const httpTrigger = configuredKeys.length > 0 ? http.trigger({authorizedKeys: configuredKeys}) : http.trigger({});
  handlers.push(cre.handler(httpTrigger, onHttpFeature4));

  const eventSignatures = [
    keccak256(toBytes("OrderExecuted(uint256,bytes32,address,uint256,uint256)")),
    keccak256(toBytes("OrderSkipped(uint256,uint8)")),
    keccak256(toBytes("OrderExecutionFailed(uint256,bytes)")),
    keccak256(toBytes("OrderPaused(uint256,bool)"))
  ];

  for (const [chainIdRaw, trader] of Object.entries(config.automatedTraderByChainId)) {
    const chainId = Number(chainIdRaw);
    if (!Number.isFinite(chainId)) continue;
    if (!isAddress(trader)) continue;

    const selectorRaw = config.chainSelectorByChainId[chainIdRaw];
    if (!selectorRaw) continue;

    const evm = new cre.capabilities.EVMClient(BigInt(selectorRaw));
    const trigger = evm.logTrigger({
      addresses: [trader],
      topics: [
        {values: eventSignatures},
        {values: []},
        {values: []},
        {values: []}
      ],
      confidence: "CONFIDENCE_LEVEL_SAFE"
    });

    handlers.push(cre.handler(trigger, (runtime: Runtime<Feature4Config>, logPayload: unknown) => {
      return onDcaLog(runtime, chainId, trader, logPayload);
    }));
  }

  return handlers as unknown as Workflow<Feature4Config>;
}

export async function main() {
  const runner = await Runner.newRunner<Feature4Config>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("Feature4 intelligence workflow failed:", error);
  process.exit(1);
});
