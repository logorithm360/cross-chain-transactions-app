import {
  cre,
  Runner,
  prepareReportRequest,
  bytesToHex,
  encodeCallMsg,
  decodeJson,
  LATEST_BLOCK_NUMBER,
  type Runtime,
  type HTTPPayload
} from "@chainlink/cre-sdk";
import {decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Hex} from "viem";
import type {
  AutoPilotConfig,
  AutoPilotOutcome,
  AutoPilotRequest,
  ExecutionMode,
  GeminiDecision,
  PreflightReport,
  ResolvedExecutionConfig,
  SecurityDecision,
  WorkflowRecord
} from "./autopilot.types";
import { resolveExecutionConfig as resolveExecutionConfigFromRegistry } from "./chain-resolver";
import {decideWithGemini} from "./autopilot.gemini";
import {
  buildBlockedNotification,
  buildDecisionNotification,
  buildExecutionNotification
} from "./autopilot.notifications";

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normalizeAddress(input: string): string {
  return input.toLowerCase();
}


function deterministicRequestId(payload: Uint8Array): string {
  const raw = new TextDecoder().decode(payload);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 33 + raw.charCodeAt(i)) >>> 0;
  return `dca_${hash.toString(16).padStart(8, "0")}`;
}

function toBytes32FromText(value: string): Hex {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 16777619 + value.charCodeAt(i)) >>> 0;
  return `0x${hash.toString(16).padStart(64, "0")}` as Hex;
}

function mapToMetadataHash(input: AutoPilotRequest): string {
  const raw = `${input.user}|${input.token}|${input.amount}|${input.action}|${input.walletChainId}|${input.destinationChainId}|${input.cadenceSeconds}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

function validateRuntimeConfig(config: AutoPilotConfig): void {
  if (config.decisionMode !== "GEMINI") {
    throw new Error("Invalid config: decisionMode must be GEMINI");
  }
  if (!config.geminiApiUrl) {
    throw new Error("Invalid config: geminiApiUrl is required");
  }
  if (config.geminiFailurePolicy === "EXECUTE_SAFE") {
    const maxAmount = config.executeSafeMaxAmountWei ?? "0";
    if (BigInt(maxAmount) <= 0n) {
      throw new Error("Invalid config: EXECUTE_SAFE policy requires executeSafeMaxAmountWei > 0");
    }
    if (config.securityEnforcementMode === "ENFORCE") {
      throw new Error("Invalid config: EXECUTE_SAFE policy is not allowed when securityEnforcementMode=ENFORCE");
    }
  }
  if (config.feature5Enabled && (!config.userRecordRegistryContract || !isAddress(config.userRecordRegistryContract))) {
    throw new Error("Invalid config: feature5Enabled requires valid userRecordRegistryContract");
  }
  if (config.feature6Enabled) {
    if (!config.securityManagerContract || !isAddress(config.securityManagerContract)) {
      throw new Error("Invalid config: feature6Enabled requires valid securityManagerContract");
    }
    if (!config.tokenVerifierContract || !isAddress(config.tokenVerifierContract)) {
      throw new Error("Invalid config: feature6Enabled requires valid tokenVerifierContract");
    }
  }

  for (const [chainId, trader] of Object.entries(config.automatedTraderByChainId)) {
    if (!isAddress(trader)) {
      throw new Error(`Invalid config: automatedTraderByChainId[${chainId}] is not a valid address`);
    }
  }
}

function emitOpsLog(
  runtime: Runtime<AutoPilotConfig>,
  event: string,
  payload: Record<string, unknown>
): void {
  if (!runtime.config.emitStructuredLogs) return;
  runtime.log(`[ops] ${JSON.stringify({service: "AUTOPILOT_DCA", event, ...payload})}`);
}

function isGeminiUnavailableReason(reason: string): boolean {
  return reason.startsWith("GEMINI_") || reason.includes("Gemini API error");
}

function applyGeminiFailurePolicy(
  config: AutoPilotConfig,
  request: AutoPilotRequest,
  security: SecurityDecision
): GeminiDecision {
  const policy = config.geminiFailurePolicy ?? "SKIP";
  if (policy !== "EXECUTE_SAFE") {
    return {
      action: "SKIP",
      confidence: 0,
      reason: "GEMINI_UNAVAILABLE_POLICY_SKIP",
      operatorMessage: "Gemini unavailable; policy set to SKIP"
    };
  }

  if (!security.allow) {
    return {
      action: "SKIP",
      confidence: 0,
      reason: "GEMINI_UNAVAILABLE_SECURITY_BLOCKED",
      operatorMessage: "Gemini unavailable; security gate blocks execution"
    };
  }

  let amount = 0n;
  try {
    amount = BigInt(request.amount);
  } catch {
    return {
      action: "SKIP",
      confidence: 0,
      reason: "GEMINI_UNAVAILABLE_INVALID_AMOUNT",
      operatorMessage: "Gemini unavailable; invalid amount for safe fallback"
    };
  }

  const safeMax = BigInt(config.executeSafeMaxAmountWei ?? "0");
  if (amount > safeMax || safeMax <= 0n) {
    return {
      action: "SKIP",
      confidence: 0,
      reason: "GEMINI_UNAVAILABLE_ABOVE_SAFE_MAX",
      operatorMessage: "Gemini unavailable; amount exceeds safe fallback limit"
    };
  }

  return {
    action: "EXECUTE",
    confidence: 35,
    reason: "GEMINI_UNAVAILABLE_FALLBACK_EXECUTE_SAFE",
    operatorMessage: "Gemini unavailable; executing under bounded safe fallback policy"
  };
}

async function resolveExecutionConfig(
  request: AutoPilotRequest,
  config: AutoPilotConfig,
  runtime: Runtime<AutoPilotConfig>
): Promise<{ resolved: ResolvedExecutionConfig; preflight: PreflightReport }> {
  const base = await resolveExecutionConfigFromRegistry(request, config, runtime);
  return {
    resolved: {
      ...(base.resolved as unknown as ResolvedExecutionConfig),
      executionMode: request.executionMode,
      receiverContract: request.receiverContract,
      contracts: {
        ...(base.resolved.contracts as unknown as ResolvedExecutionConfig["contracts"]),
        automatedTrader: base.resolved.contracts.automatedTrader ?? base.resolved.contracts.sourceSender
      }
    },
    preflight: base.preflight as unknown as PreflightReport
  };
}

function runSecurityChecks(request: AutoPilotRequest, config: AutoPilotConfig): SecurityDecision {
  const mode = config.securityEnforcementMode;
  if (!config.feature6Enabled) {
    return {allow: true, enforcementMode: mode, reasonCode: "SECURITY_DISABLED", incidentLogged: false};
  }

  const token = normalizeAddress(request.token);
  if (config.tokenBlocklist.map(normalizeAddress).includes(token)) {
    return {
      allow: mode === "MONITOR",
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TOKEN_BLOCKLISTED",
      incidentLogged: true
    };
  }

  if (config.tokenAllowlist.length > 0 && !config.tokenAllowlist.map(normalizeAddress).includes(token)) {
    return {
      allow: mode === "MONITOR",
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TOKEN_NOT_ALLOWLISTED",
      incidentLogged: true
    };
  }

  let amount = 0n;
  try {
    amount = BigInt(request.amount);
  } catch {
    return {
      allow: mode === "MONITOR",
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:INVALID_AMOUNT",
      incidentLogged: true
    };
  }

  if (amount > BigInt(config.maxTransferAmountWei)) {
    return {
      allow: mode === "MONITOR",
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TRANSFER_LIMIT",
      incidentLogged: true
    };
  }

  return {allow: true, enforcementMode: mode, reasonCode: "SECURITY_ALLOWED", incidentLogged: false};
}

async function readOnchainSecurityState(
  runtime: Runtime<AutoPilotConfig>,
  resolved: ResolvedExecutionConfig
): Promise<{paused: boolean; enforcementMode: "MONITOR" | "ENFORCE"; tokenStatus?: number}> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  let paused = false;
  let enforcementMode: "MONITOR" | "ENFORCE" = "MONITOR";
  let tokenStatus: number | undefined;

  if (resolved.contracts.securityManager && isAddress(resolved.contracts.securityManager)) {
    const data = encodeFunctionData({
      abi: [{
        type: "function",
        name: "getSystemHealth",
        stateMutability: "view",
        inputs: [],
        outputs: [
          {name: "healthy", type: "bool"},
          {name: "systemPaused", type: "bool"},
          {name: "mode", type: "uint8"},
          {name: "totalIncidents", type: "uint256"},
          {name: "globalLimit", type: "uint256"}
        ]
      }],
      functionName: "getSystemHealth"
    });
    const out = evmClient.callContract(runtime, {
      call: encodeCallMsg({
        from: (resolved.contracts.automatedTrader ?? resolved.contracts.securityManager) as `0x${string}`,
        to: resolved.contracts.securityManager as `0x${string}`,
        data
      }),
      blockNumber: LATEST_BLOCK_NUMBER
    }).result();

    const decoded = decodeFunctionResult({
      abi: [{
        type: "function",
        name: "getSystemHealth",
        stateMutability: "view",
        inputs: [],
        outputs: [
          {name: "healthy", type: "bool"},
          {name: "systemPaused", type: "bool"},
          {name: "mode", type: "uint8"},
          {name: "totalIncidents", type: "uint256"},
          {name: "globalLimit", type: "uint256"}
        ]
      }],
      functionName: "getSystemHealth",
      data: bytesToHex(out.data)
    }) as readonly [boolean, boolean, number, bigint, bigint];

    paused = decoded[1];
    enforcementMode = decoded[2] === 1 ? "ENFORCE" : "MONITOR";
  }

  if (resolved.contracts.tokenVerifier && isAddress(resolved.contracts.tokenVerifier)) {
    const data = encodeFunctionData({
      abi: [{
        type: "function",
        name: "getStatus",
        stateMutability: "view",
        inputs: [{name: "_token", type: "address"}],
        outputs: [{name: "", type: "uint8"}]
      }],
      functionName: "getStatus",
      args: [resolved.token as `0x${string}`]
    });
    const out = evmClient.callContract(runtime, {
      call: encodeCallMsg({
        from: (resolved.contracts.automatedTrader ?? resolved.contracts.tokenVerifier) as `0x${string}`,
        to: resolved.contracts.tokenVerifier as `0x${string}`,
        data
      }),
      blockNumber: LATEST_BLOCK_NUMBER
    }).result();

    tokenStatus = decodeFunctionResult({
      abi: [{
        type: "function",
        name: "getStatus",
        stateMutability: "view",
        inputs: [{name: "_token", type: "address"}],
        outputs: [{name: "", type: "uint8"}]
      }],
      functionName: "getStatus",
      data: bytesToHex(out.data)
    }) as number;
  }

  return {paused, enforcementMode, tokenStatus};
}

function mapRecordStatus(phase: string): number {
  if (phase === "REQUEST_RECEIVED") return 0; // CREATED
  if (phase.startsWith("PREFLIGHT_")) return 1; // SENT
  if (phase === "SECURITY_ALLOWED") return 1; // SENT
  if (phase === "SECURITY_BLOCKED") return 5; // FAILED
  if (phase.startsWith("DECISION_")) return 1; // SENT
  if (phase === "EXECUTION_SUBMITTED") return 1; // SENT
  return 5; // FAILED
}

function buildWorkflowRecords(
  requestId: string,
  request: AutoPilotRequest,
  phases: string[],
  feature5Enabled: boolean
): WorkflowRecord[] {
  const keyBase = `${requestId}:${request.walletChainId}:${request.destinationChainId}`;
  const metadataHash = mapToMetadataHash(request);

  if (!feature5Enabled) {
    return [
      {
        phase: "REQUEST_RECEIVED",
        externalEventKey: `${keyBase}:request`,
        status: "RECORDED_LOCALLY_ONLY",
        metadataHash
      }
    ];
  }

  return phases.map((phase) => ({
    phase,
    externalEventKey: `${keyBase}:${phase.toLowerCase()}`,
    status: "PENDING_APPEND",
    metadataHash
  }));
}

async function appendWorkflowRecordsOnchain(
  runtime: Runtime<AutoPilotConfig>,
  resolved: ResolvedExecutionConfig,
  request: AutoPilotRequest,
  requestId: string,
  phases: string[],
  txHash?: string
): Promise<void> {
  if (!runtime.config.feature5Enabled) return;
  if (!resolved.contracts.userRecordRegistry || !isAddress(resolved.contracts.userRecordRegistry)) return;
  if (!resolved.contracts.automatedTrader || !isAddress(resolved.contracts.automatedTrader)) return;

  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const registry = resolved.contracts.userRecordRegistry as `0x${string}`;
  const sourceContract = resolved.contracts.automatedTrader as `0x${string}`;
  const messageId = txHash && /^0x[a-fA-F0-9]{64}$/.test(txHash) ? (txHash as Hex) : (`0x${"0".repeat(64)}` as Hex);
  const metadataHash = mapToMetadataHash(request) as Hex;
  const actionHash = keccak256(toBytes(request.action));

  for (const phase of phases) {
    const data = encodeFunctionData({
      abi: [{
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
      }],
      functionName: "appendRecord",
      args: [
        {
          user: request.user as `0x${string}`,
          featureType: 3, // AUTOMATED_TRADER
          chainSelector: BigInt(resolved.sourceChainSelector),
          sourceContract,
          counterparty: request.recipient as `0x${string}`,
          messageId,
          assetToken: request.token as `0x${string}`,
          amount: BigInt(request.amount),
          actionHash,
          status: mapRecordStatus(phase),
          metadataHash
        },
        toBytes32FromText(`${requestId}:${phase}`)
      ]
    });

    const report = runtime.report(prepareReportRequest(data)).result();
    evmClient.writeReport(runtime, {
      receiver: registry,
      report,
      gasConfig: {gasLimit: runtime.config.sourceChainWriteGasLimit ?? "850000"}
    }).result();
  }
}

async function submitSourceChainWrite(
  runtime: Runtime<AutoPilotConfig>,
  resolved: ResolvedExecutionConfig,
  to: `0x${string}`,
  calldata: Hex
): Promise<{submitted: boolean; message: string; reasonCode?: string; txHash?: string}> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const report = runtime.report(prepareReportRequest(calldata)).result();
  const write = evmClient.writeReport(runtime, {
    receiver: to,
    report,
    gasConfig: {gasLimit: runtime.config.sourceChainWriteGasLimit ?? "1000000"}
  }).result();
  const txHash = write.txHash && write.txHash.length > 0 ? bytesToHex(write.txHash) : undefined;
  return {
    submitted: true,
    message: "Source chain transaction submitted via CRE EVM write capability",
    reasonCode: "EXECUTION_SUBMITTED",
    txHash
  };
}

function policyBlocked(
  executionMode: ExecutionMode,
  config: AutoPilotConfig
): {blocked: boolean; reasonCode?: string} {
  if (executionMode === "CREATE_ORDER" && !config.allowCreateOrderFromWorkflow) {
    return {blocked: true, reasonCode: "EXECUTION_POLICY_DISABLED_CREATE_ORDER"};
  }
  if (executionMode === "RUN_UPKEEP" && !config.allowPerformUpkeepFromWorkflow) {
    return {blocked: true, reasonCode: "EXECUTION_POLICY_DISABLED_RUN_UPKEEP"};
  }
  return {blocked: false};
}

async function executeServiceAction(
  runtime: Runtime<AutoPilotConfig>,
  resolved: ResolvedExecutionConfig,
  request: AutoPilotRequest,
  security: SecurityDecision,
  decision: GeminiDecision
): Promise<{submitted: boolean; message: string; reasonCode?: string; txHash?: string}> {
  if (!security.allow) {
    return {submitted: false, message: "Execution blocked by Feature 6 security policy", reasonCode: security.reasonCode};
  }

  if (decision.action !== "EXECUTE") {
    return {
      submitted: false,
      message: `Execution skipped by decision branch: ${decision.action}`,
      reasonCode: `DECISION_${decision.action}`
    };
  }

  if (resolved.state !== "READY") {
    return {submitted: false, message: "Execution blocked: unresolved contracts/config", reasonCode: "CONTRACT_NOT_DEPLOYED"};
  }
  if (!resolved.contracts.automatedTrader || !isAddress(resolved.contracts.automatedTrader)) {
    return {submitted: false, message: "Missing AutomatedTrader address", reasonCode: "CONTRACT_NOT_DEPLOYED"};
  }

  const policy = policyBlocked(request.executionMode, runtime.config);
  if (policy.blocked) {
    return {submitted: false, message: "Execution disabled by safety policy", reasonCode: policy.reasonCode};
  }

  const trader = resolved.contracts.automatedTrader as `0x${string}`;
  if (request.executionMode === "CREATE_ORDER") {
    const calldata = encodeFunctionData({
      abi: [{
        type: "function",
        name: "createTimedOrder",
        stateMutability: "nonpayable",
        inputs: [
          {name: "_intervalSeconds", type: "uint256"},
          {name: "_token", type: "address"},
          {name: "_amount", type: "uint256"},
          {name: "_destinationChain", type: "uint64"},
          {name: "_receiverContract", type: "address"},
          {name: "_recipient", type: "address"},
          {name: "_action", type: "string"},
          {name: "_recurring", type: "bool"},
          {name: "_maxExecutions", type: "uint256"},
          {name: "_deadline", type: "uint256"}
        ],
        outputs: [{name: "orderId", type: "uint256"}]
      }],
      functionName: "createTimedOrder",
      args: [
        BigInt(request.cadenceSeconds),
        request.token as `0x${string}`,
        BigInt(request.amount),
        BigInt(resolved.destinationChainSelector),
        request.receiverContract as `0x${string}`,
        request.recipient as `0x${string}`,
        request.action,
        request.recurring,
        BigInt(request.maxExecutions),
        BigInt(request.deadline)
      ]
    });
    return submitSourceChainWrite(runtime, resolved, trader, calldata);
  }

  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const checkData = encodeFunctionData({
    abi: [{
      type: "function",
      name: "checkUpkeep",
      stateMutability: "view",
      inputs: [{name: "", type: "bytes"}],
      outputs: [{name: "upkeepNeeded", type: "bool"}, {name: "performData", type: "bytes"}]
    }],
    functionName: "checkUpkeep",
    args: ["0x"]
  });

  const checkOut = evmClient.callContract(runtime, {
    call: encodeCallMsg({
      from: trader,
      to: trader,
      data: checkData
    }),
    blockNumber: LATEST_BLOCK_NUMBER
  }).result();

  const [needed, performData] = decodeFunctionResult({
    abi: [{
      type: "function",
      name: "checkUpkeep",
      stateMutability: "view",
      inputs: [{name: "", type: "bytes"}],
      outputs: [{name: "upkeepNeeded", type: "bool"}, {name: "performData", type: "bytes"}]
    }],
    functionName: "checkUpkeep",
    data: bytesToHex(checkOut.data)
  }) as readonly [boolean, Hex];

  if (!needed) {
    return {submitted: false, message: "No executable DCA order found (checkUpkeep=false)", reasonCode: "NO_EXECUTABLE_ORDER"};
  }

  const performCall = encodeFunctionData({
    abi: [{
      type: "function",
      name: "performUpkeep",
      stateMutability: "nonpayable",
      inputs: [{name: "performData", type: "bytes"}],
      outputs: []
    }],
    functionName: "performUpkeep",
    args: [performData]
  });
  return submitSourceChainWrite(runtime, resolved, trader, performCall);
}

function validateRequest(request: AutoPilotRequest): string[] {
  const errors: string[] = [];
  if (!request.serviceType) errors.push("serviceType is required");
  if (!request.executionMode) errors.push("executionMode is required");
  if (!request.user || !isAddress(request.user)) errors.push("user must be a valid EVM address");
  if (!request.token || !isAddress(request.token)) errors.push("token must be a valid EVM address");
  if (!request.amount) errors.push("amount is required");
  if (!request.recipient || !isAddress(request.recipient)) errors.push("recipient must be a valid EVM address");
  if (!request.receiverContract || !isAddress(request.receiverContract)) errors.push("receiverContract must be a valid EVM address");
  if (!request.action) errors.push("action is required");
  if (request.cadenceSeconds <= 0) errors.push("cadenceSeconds must be > 0");
  if (!request.walletChainId) errors.push("walletChainId is required");
  if (!request.destinationChainId) errors.push("destinationChainId is required");
  if (request.executionMode !== "CREATE_ORDER" && request.executionMode !== "RUN_UPKEEP") {
    errors.push("executionMode must be CREATE_ORDER or RUN_UPKEEP");
  }
  return errors;
}

async function handleAutoPilotRequest(
  runtime: Runtime<AutoPilotConfig>,
  request: AutoPilotRequest,
  requestId: string
): Promise<string> {
  const timestamp = runtime.now().toISOString();
  const errors = validateRequest(request);
  if (errors.length > 0) {
    return JSON.stringify({success: false, requestId, timestamp, error: "Validation failed", details: errors});
  }

  runtime.log(`[${requestId}] AutoPilot DCA request mode=${request.executionMode} ${request.walletChainId} -> ${request.destinationChainId}`);
  emitOpsLog(runtime, "request_received", {
    requestId,
    mode: request.executionMode,
    sourceChainId: request.walletChainId,
    destinationChainId: request.destinationChainId
  });

  const {resolved, preflight} = await resolveExecutionConfig(request, runtime.config, runtime);
  if (resolved.state === "BLOCKED") {
    const phases = ["REQUEST_RECEIVED", "PREFLIGHT_FAILED", "SECURITY_BLOCKED", "DECISION_SKIP"];
    const decision: GeminiDecision = {
      action: "SKIP",
      confidence: 0,
      reason: `Resolver blocked: ${resolved.blockedReason}`,
      operatorMessage: "Resolver blocked before execution"
    };
    const notifications = runtime.config.notificationsEnabled
      ? [buildBlockedNotification(requestId, String(resolved.blockedReason ?? "UNKNOWN"))]
      : [];
    const outcome: AutoPilotOutcome = {
      requestId,
      timestamp,
      status: "BLOCKED",
      resolver: resolved,
      preflight,
      security: {
        allow: false,
        enforcementMode: runtime.config.securityEnforcementMode,
        reasonCode: resolved.blockedReason,
        incidentLogged: true
      },
      decision,
      records: buildWorkflowRecords(requestId, request, phases, runtime.config.feature5Enabled),
      execution: {submitted: false, message: "No execution attempted", reasonCode: "RESOLVER_BLOCKED"},
      notifications
    };
    return JSON.stringify({success: true, requestId, timestamp, data: outcome});
  }

  let security = runSecurityChecks(request, runtime.config);
  if (runtime.config.feature6Enabled) {
    const onchain = await readOnchainSecurityState(runtime, resolved);
    if (runtime.config.securityEnforcementMode === "ENFORCE" || onchain.enforcementMode === "ENFORCE") {
      security.enforcementMode = "ENFORCE";
    }
    if (onchain.paused) {
      security = {
        allow: onchain.enforcementMode === "MONITOR",
        enforcementMode: onchain.enforcementMode,
        reasonCode: "SECURITY_BLOCKED:PAUSED",
        incidentLogged: true
      };
    } else if (onchain.tokenStatus === 6) {
      security = {
        allow: onchain.enforcementMode === "MONITOR",
        enforcementMode: onchain.enforcementMode,
        reasonCode: "SECURITY_BLOCKED:TOKEN_BLOCKLISTED",
        incidentLogged: true
      };
    }
  }

  if ((security.reasonCode?.startsWith("SECURITY_BLOCKED") ?? false) && security.enforcementMode === "ENFORCE") {
    security = {...security, allow: false};
  }

  const aiDecision = decideWithGemini(runtime, request);
  const aiRawReason = aiDecision.reason;
  let decision = aiDecision;
  let decisionSource: AutoPilotOutcome["decisionSource"] = "GEMINI";
  if (isGeminiUnavailableReason(decision.reason)) {
    decision = applyGeminiFailurePolicy(runtime.config, request, security);
    decisionSource = "FALLBACK_POLICY";
    decision.operatorMessage = `${decision.operatorMessage} | aiReason=${aiRawReason}`;
    emitOpsLog(runtime, "ai_fallback_applied", {
      requestId,
      aiRawReason,
      fallbackReason: decision.reason,
      policy: runtime.config.geminiFailurePolicy ?? "SKIP"
    });
  }

  const execution = await executeServiceAction(runtime, resolved, request, security, decision);
  const securityPhase = security.allow ? "SECURITY_ALLOWED" : "SECURITY_BLOCKED";
  const decisionPhase = `DECISION_${decision.action}`;
  const phases = ["REQUEST_RECEIVED", "PREFLIGHT_PASSED", securityPhase, decisionPhase];
  if (execution.submitted) phases.push("EXECUTION_SUBMITTED");

  await appendWorkflowRecordsOnchain(runtime, resolved, request, requestId, phases, execution.txHash);

  const notifications: string[] = [];
  if (runtime.config.notificationsEnabled) {
    notifications.push(buildDecisionNotification(decision, request, requestId));
    if (execution.submitted) notifications.push(buildExecutionNotification(requestId, execution.txHash));
    if (!security.allow && security.reasonCode) notifications.push(buildBlockedNotification(requestId, security.reasonCode));
  }

  for (const n of notifications) runtime.log(`[${requestId}] ${n}`);

  const status: AutoPilotOutcome["status"] =
    resolved.state === "READY" && security.allow && execution.submitted
      ? "READY"
      : (!security.allow ? "BLOCKED" : (resolved.state === "DEGRADED" ? "DEGRADED" : "READY"));

  const outcome: AutoPilotOutcome = {
    requestId,
    timestamp,
    status,
    resolver: resolved,
    preflight,
    security,
    decision,
    decisionSource,
    records: buildWorkflowRecords(requestId, request, phases, runtime.config.feature5Enabled),
    execution,
    notifications
  };

  emitOpsLog(runtime, "workflow_outcome", {
    requestId,
    status,
    securityAllow: security.allow,
    securityReason: security.reasonCode ?? "",
    decisionAction: decision.action,
    decisionSource,
    decisionReason: decision.reason,
    executionSubmitted: execution.submitted,
    executionReasonCode: execution.reasonCode ?? ""
  });

  return JSON.stringify({success: true, requestId, timestamp, data: outcome});
}

const onHttpAutoPilot = async (runtime: Runtime<AutoPilotConfig>, payload: HTTPPayload): Promise<string> => {
  if (!payload.input || payload.input.length === 0) {
    return JSON.stringify({
      success: false,
      requestId: "dca_empty_input",
      timestamp: runtime.now().toISOString(),
      error: "Empty request body"
    });
  }

  const requestId = deterministicRequestId(payload.input);
  try {
    const request = decodeJson(payload.input) as AutoPilotRequest;
    return handleAutoPilotRequest(runtime, request, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.log(`[${requestId}] AutoPilot error: ${message}`);
    return JSON.stringify({success: false, requestId, timestamp: runtime.now().toISOString(), error: message});
  }
};

const onCronAutoPilot = async (runtime: Runtime<AutoPilotConfig>): Promise<string> => {
  const request = runtime.config.cronRequest;
  if (!request) {
    return JSON.stringify({
      success: false,
      requestId: "dca_cron_missing_config",
      timestamp: runtime.now().toISOString(),
      error: "Missing cronRequest in workflow config"
    });
  }
  const requestId = toBytes32FromText(JSON.stringify(request)).slice(0, 10).replace("0x", "dca_");
  return handleAutoPilotRequest(runtime, request, requestId);
};

const initWorkflow = (config: AutoPilotConfig) => {
  validateRuntimeConfig(config);

  const handlers: unknown[] = [];
  const cron = new cre.capabilities.CronCapability();
  handlers.push(cre.handler(cron.trigger({schedule: config.schedule}), onCronAutoPilot));

  const http = new cre.capabilities.HTTPCapability();
  const configuredKeys = (config.authorizedEVMAddresses ?? [])
    .filter((addr) => isAddress(addr))
    .map((addr) => ({type: "KEY_TYPE_ECDSA_EVM" as const, publicKey: addr}));
  const httpTrigger = configuredKeys.length > 0 ? http.trigger({authorizedKeys: configuredKeys}) : http.trigger({});
  handlers.push(cre.handler(httpTrigger, onHttpAutoPilot));
  return handlers;
};

export async function main() {
  const runner = await Runner.newRunner<AutoPilotConfig>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("AutoPilot workflow failed:", error);
  process.exit(1);
});
