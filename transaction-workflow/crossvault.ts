import {
  cre,
  Runner,
  prepareReportRequest,
  bytesToHex,
  encodeCallMsg,
  LATEST_BLOCK_NUMBER,
  type Runtime,
  type HTTPPayload,
  decodeJson
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes, type Hex } from "viem";
import type {
  CrossVaultConfig,
  CrossVaultOutcome,
  CrossVaultRequest,
  PreflightReport,
  RecommendationInternalMeta,
  ResolvedExecutionConfig,
  SecurityDecision,
  UserBlockedReason,
  VaultRecommendation,
  WorkflowRecord
} from "./crossvault.types";
import { resolveExecutionConfig as resolveExecutionConfigFromRegistry } from "./chain-resolver";
import { resolveRecommendation } from "./crossvault.recommendation";
import { resolveConfidentialContext } from "./confidential.compute";

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
  return `cv_${hash.toString(16).padStart(8, "0")}`;
}

function mapToMetadataHash(input: CrossVaultRequest): string {
  const raw = `${input.user}|${input.token}|${input.amount}|${input.intent}|${input.riskProfile}|${input.walletChainId}|${input.destinationChainId}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

function toBytes32FromText(value: string): Hex {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 16777619 + value.charCodeAt(i)) >>> 0;
  return `0x${hash.toString(16).padStart(64, "0")}` as Hex;
}

function toBytes32OrZero(value?: string): Hex {
  if (value && /^0x[a-fA-F0-9]{64}$/.test(value)) return value as Hex;
  return `0x${"0".repeat(64)}` as Hex;
}

function utf8ToHex(value: string): Hex {
  const bytes = new TextEncoder().encode(value);
  let hex = "0x";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex as Hex;
}

function buildApprovalMessage(request: CrossVaultRequest, recommendation: VaultRecommendation): string {
  return [
    `CrossVault recommendation: ${recommendation.strategyAction} on ${recommendation.protocol}`,
    `chainId=${recommendation.recommendedDestinationChainId}`,
    `estAPY=${(recommendation.estimatedApyBps / 100).toFixed(2)}%`,
    `risk=${recommendation.riskAssessment}`,
    `intent=${request.intent}`
  ].join(" | ");
}

function emitOpsLog(
  runtime: Runtime<CrossVaultConfig>,
  event: string,
  payload: Record<string, unknown>
): void {
  if (!runtime.config.emitStructuredLogs) return;
  runtime.log(`[ops] ${JSON.stringify({ service: "CROSSVAULT", event, ...payload })}`);
}

function mapRouteBlockedReason(reason?: string): UserBlockedReason {
  if (!reason) return "UNSUPPORTED_ROUTE";
  if (
    reason === "CHAIN_UNSUPPORTED" ||
    reason === "LANE_DISABLED" ||
    reason === "CONTRACT_NOT_DEPLOYED" ||
    reason === "TOKEN_MAPPING_MISSING" ||
    reason === "FEE_ESTIMATION_FAILED"
  ) {
    return "UNSUPPORTED_ROUTE";
  }
  return "UNSUPPORTED_ROUTE";
}

function validateRuntimeConfig(config: CrossVaultConfig): void {
  if (config.recommendationMode !== "OPENAI") {
    throw new Error("Invalid config: recommendationMode must be OPENAI");
  }
  if (!config.openaiModel || config.openaiModel.trim().length === 0) {
    throw new Error("Invalid config: openaiModel is required");
  }
  if (!config.schedule || config.schedule.trim().length === 0) {
    throw new Error("Invalid config: schedule is required");
  }
  if (config.supportedOpportunityChainIds.length === 0) {
    throw new Error("Invalid config: supportedOpportunityChainIds must not be empty");
  }
  if (!config.recommendationPolicy) {
    throw new Error("Invalid config: recommendationPolicy is required");
  }
  if (config.recommendationPolicy.timeoutMs <= 0) {
    throw new Error("Invalid config: recommendationPolicy.timeoutMs must be > 0");
  }
  if (BigInt(config.recommendationPolicy.fallbackExecutionMaxAmountWei) <= 0n) {
    throw new Error("Invalid config: recommendationPolicy.fallbackExecutionMaxAmountWei must be > 0");
  }
  if (config.recommendationPolicy.opportunityCatalog.length === 0) {
    throw new Error("Invalid config: recommendationPolicy.opportunityCatalog must not be empty");
  }
}

async function resolveExecutionConfig(
  request: CrossVaultRequest,
  config: CrossVaultConfig,
  runtime: Runtime<CrossVaultConfig>
): Promise<{ resolved: ResolvedExecutionConfig; preflight: PreflightReport }> {
  return (await resolveExecutionConfigFromRegistry(request, config, runtime)) as {
    resolved: ResolvedExecutionConfig;
    preflight: PreflightReport;
  };
}

function runSecurityChecks(request: CrossVaultRequest, config: CrossVaultConfig): SecurityDecision {
  const mode = config.securityEnforcementMode;
  const token = normalizeAddress(request.token);

  if (!config.feature6Enabled) {
    return { allow: true, enforcementMode: mode, reasonCode: "SECURITY_DISABLED", incidentLogged: false };
  }

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

  try {
    const amount = BigInt(request.amount);
    if (amount > BigInt(config.maxTransferAmountWei)) {
      return {
        allow: mode === "MONITOR",
        enforcementMode: mode,
        reasonCode: "SECURITY_BLOCKED:TRANSFER_LIMIT",
        incidentLogged: true
      };
    }
  } catch {
    return {
      allow: mode === "MONITOR",
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:INVALID_AMOUNT",
      incidentLogged: true
    };
  }

  return { allow: true, enforcementMode: mode, reasonCode: "SECURITY_ALLOWED", incidentLogged: false };
}

async function readOnchainSecurityState(
  runtime: Runtime<CrossVaultConfig>,
  resolved: ResolvedExecutionConfig
): Promise<{ paused: boolean; enforcementMode: "MONITOR" | "ENFORCE"; tokenStatus?: number }> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  let paused = false;
  let enforcementMode: "MONITOR" | "ENFORCE" = "MONITOR";
  let tokenStatus: number | undefined;

  if (resolved.contracts.securityManager && isAddress(resolved.contracts.securityManager)) {
    const callData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "getSystemHealth",
          stateMutability: "view",
          inputs: [],
          outputs: [
            { name: "healthy", type: "bool" },
            { name: "systemPaused", type: "bool" },
            { name: "mode", type: "uint8" },
            { name: "totalIncidents", type: "uint256" },
            { name: "globalLimit", type: "uint256" }
          ]
        }
      ],
      functionName: "getSystemHealth"
    });

    const out = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: (resolved.contracts.sourceSender ?? resolved.contracts.securityManager) as `0x${string}`,
          to: resolved.contracts.securityManager as `0x${string}`,
          data: callData
        }),
        blockNumber: LATEST_BLOCK_NUMBER
      })
      .result();

    const decoded = decodeFunctionResult({
      abi: [
        {
          type: "function",
          name: "getSystemHealth",
          stateMutability: "view",
          inputs: [],
          outputs: [
            { name: "healthy", type: "bool" },
            { name: "systemPaused", type: "bool" },
            { name: "mode", type: "uint8" },
            { name: "totalIncidents", type: "uint256" },
            { name: "globalLimit", type: "uint256" }
          ]
        }
      ],
      functionName: "getSystemHealth",
      data: bytesToHex(out.data)
    }) as readonly [boolean, boolean, number, bigint, bigint];

    paused = decoded[1];
    enforcementMode = decoded[2] === 1 ? "ENFORCE" : "MONITOR";
  }

  if (resolved.contracts.tokenVerifier && isAddress(resolved.contracts.tokenVerifier)) {
    const callData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "getStatus",
          stateMutability: "view",
          inputs: [{ name: "_token", type: "address" }],
          outputs: [{ name: "", type: "uint8" }]
        }
      ],
      functionName: "getStatus",
      args: [resolved.token as `0x${string}`]
    });

    const out = evmClient
      .callContract(runtime, {
        call: encodeCallMsg({
          from: (resolved.contracts.sourceSender ?? resolved.contracts.tokenVerifier) as `0x${string}`,
          to: resolved.contracts.tokenVerifier as `0x${string}`,
          data: callData
        }),
        blockNumber: LATEST_BLOCK_NUMBER
      })
      .result();

    tokenStatus = decodeFunctionResult({
      abi: [
        {
          type: "function",
          name: "getStatus",
          stateMutability: "view",
          inputs: [{ name: "_token", type: "address" }],
          outputs: [{ name: "", type: "uint8" }]
        }
      ],
      functionName: "getStatus",
      data: bytesToHex(out.data)
    }) as number;
  }

  return { paused, enforcementMode, tokenStatus };
}

function appendWorkflowRecords(
  requestId: string,
  request: CrossVaultRequest,
  securityPhase: string,
  feature5Enabled: boolean,
  recommendationPhase: string,
  approvalPhase?: string,
  executionPhase?: string
): WorkflowRecord[] {
  const keyBase = `${requestId}:${request.walletChainId}:${request.destinationChainId}`;
  const metadataHash = mapToMetadataHash(request);
  const records: WorkflowRecord[] = [
    {
      phase: "REQUEST_RECEIVED",
      externalEventKey: `${keyBase}:request_received`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    },
    {
      phase: "PREFLIGHT_PASSED",
      externalEventKey: `${keyBase}:preflight_passed`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    },
    {
      phase: securityPhase,
      externalEventKey: `${keyBase}:security`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    },
    {
      phase: recommendationPhase,
      externalEventKey: `${keyBase}:recommendation`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    }
  ];

  if (approvalPhase) {
    records.push({
      phase: approvalPhase,
      externalEventKey: `${keyBase}:approval`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    });
  }

  if (executionPhase) {
    records.push({
      phase: executionPhase,
      externalEventKey: `${keyBase}:execution`,
      status: feature5Enabled ? "PENDING_APPEND" : "RECORDED_LOCALLY_ONLY",
      metadataHash
    });
  }

  return records;
}

function mapRecordStatus(phase: string): number {
  if (phase === "REQUEST_RECEIVED") return 0;
  if (phase === "PREFLIGHT_PASSED") return 1;
  if (phase === "SECURITY_ALLOWED") return 1;
  if (phase === "RECOMMENDATION_READY") return 4;
  if (phase === "APPROVAL_PENDING") return 4;
  if (phase === "EXECUTION_SUBMITTED") return 1;
  if (phase === "SECURITY_BLOCKED") return 5;
  return 5;
}

async function appendWorkflowRecordsOnchain(
  runtime: Runtime<CrossVaultConfig>,
  resolved: ResolvedExecutionConfig,
  request: CrossVaultRequest,
  requestId: string,
  phases: string[],
  txHash?: string
): Promise<void> {
  if (!runtime.config.feature5Enabled) return;
  if (!resolved.contracts.userRecordRegistry || !isAddress(resolved.contracts.userRecordRegistry)) return;
  if (!resolved.contracts.sourceSender || !isAddress(resolved.contracts.sourceSender)) return;

  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const registry = resolved.contracts.userRecordRegistry as `0x${string}`;
  const sourceSender = resolved.contracts.sourceSender as `0x${string}`;
  const actionHash = keccak256(toBytes(request.action));
  const metadataHash = mapToMetadataHash(request) as Hex;
  const messageId = toBytes32OrZero(txHash);
  const featureType = 2; // programmable-style transfer path

  for (const phase of phases) {
    const externalEventKey = toBytes32FromText(`${requestId}:${phase}`);
    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "appendRecord",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "input",
              type: "tuple",
              components: [
                { name: "user", type: "address" },
                { name: "featureType", type: "uint8" },
                { name: "chainSelector", type: "uint64" },
                { name: "sourceContract", type: "address" },
                { name: "counterparty", type: "address" },
                { name: "messageId", type: "bytes32" },
                { name: "assetToken", type: "address" },
                { name: "amount", type: "uint256" },
                { name: "actionHash", type: "bytes32" },
                { name: "status", type: "uint8" },
                { name: "metadataHash", type: "bytes32" }
              ]
            },
            { name: "externalEventKey", type: "bytes32" }
          ],
          outputs: [{ name: "recordId", type: "uint256" }]
        }
      ],
      functionName: "appendRecord",
      args: [
        {
          user: request.user as `0x${string}`,
          featureType,
          chainSelector: BigInt(resolved.sourceChainSelector),
          sourceContract: sourceSender,
          counterparty: (resolved.contracts.destinationReceiver ?? request.recipient) as `0x${string}`,
          messageId,
          assetToken: request.token as `0x${string}`,
          amount: BigInt(request.amount),
          actionHash,
          status: mapRecordStatus(phase),
          metadataHash
        },
        externalEventKey
      ]
    });

    const report = runtime.report(prepareReportRequest(calldata)).result();
    evmClient
      .writeReport(runtime, {
        receiver: registry,
        report,
        gasConfig: { gasLimit: runtime.config.sourceChainWriteGasLimit ?? "900000" }
      })
      .result();
  }
}

async function submitSourceChainWrite(
  runtime: Runtime<CrossVaultConfig>,
  resolved: ResolvedExecutionConfig,
  to: string,
  calldata: Hex
): Promise<{ submitted: boolean; message: string; txHash?: string; reasonCode?: string }> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const report = runtime.report(prepareReportRequest(calldata)).result();
  const gasLimit = runtime.config.sourceChainWriteGasLimit ?? "900000";
  const write = evmClient
    .writeReport(runtime, {
      receiver: to as Hex,
      report,
      gasConfig: { gasLimit }
    })
    .result();

  const txHashBytes = write.txHash;
  const txHash = txHashBytes && txHashBytes.length > 0 ? bytesToHex(txHashBytes) : undefined;
  return {
    submitted: true,
    message: "CrossVault source-chain execution submitted",
    txHash,
    reasonCode: "EXECUTION_SUBMITTED"
  };
}

async function executeServiceAction(
  runtime: Runtime<CrossVaultConfig>,
  resolved: ResolvedExecutionConfig,
  request: CrossVaultRequest,
  security: SecurityDecision,
  recommendation: VaultRecommendation,
  approvalRequired: boolean
): Promise<{ submitted: boolean; message: string; txHash?: string; reasonCode?: string }> {
  if (!security.allow) {
    return {
      submitted: false,
      message: "Execution blocked by Feature 6 security policy",
      reasonCode: "SECURITY_BLOCKED"
    };
  }

  if (request.executionMode === "PLAN") {
    return {
      submitted: false,
      message: "Execution skipped in PLAN mode",
      reasonCode: "PLAN_MODE"
    };
  }

  if (approvalRequired && !request.approved) {
    return {
      submitted: false,
      message: "Execution gated: explicit approval required",
      reasonCode: "APPROVAL_REQUIRED"
    };
  }

  if (resolved.state !== "READY") {
    return {
      submitted: false,
      message: "Execution adapter is waiting for complete chain contract binding",
      reasonCode: "RESOLUTION_NOT_READY"
    };
  }

  if (!resolved.contracts.sourceSender || !resolved.contracts.destinationReceiver) {
    return {
      submitted: false,
      message: "Missing source sender or destination receiver contract",
      reasonCode: "CONTRACT_NOT_DEPLOYED"
    };
  }

  const deadline = BigInt(request.deadline ?? Math.floor(runtime.now().getTime() / 1000) + 86400);
  const extraData = utf8ToHex(
    JSON.stringify({
      protocol: recommendation.protocol,
      user: request.user,
      intent: request.intent,
      allocationModel: recommendation.allocationModel,
      estimatedApyBps: recommendation.estimatedApyBps,
      riskAssessment: recommendation.riskAssessment,
      confidence: recommendation.confidence
    })
  );
  const calldata = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "sendPayLink",
        stateMutability: "nonpayable",
        inputs: [
          { name: "_destinationChainSelector", type: "uint64" },
          { name: "_receiverContract", type: "address" },
          { name: "_token", type: "address" },
          { name: "_amount", type: "uint256" },
          {
            name: "_payload",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "action", type: "string" },
              { name: "extraData", type: "bytes" },
              { name: "deadline", type: "uint256" }
            ]
          }
        ],
        outputs: [{ name: "messageId", type: "bytes32" }]
      }
    ],
    functionName: "sendPayLink",
    args: [
      BigInt(resolved.destinationChainSelector),
      resolved.contracts.destinationReceiver as `0x${string}`,
      resolved.token as `0x${string}`,
      BigInt(resolved.amount),
      {
        recipient: resolved.recipient as `0x${string}`,
        action: recommendation.strategyAction,
        extraData,
        deadline
      }
    ]
  });

  return submitSourceChainWrite(runtime, resolved, resolved.contracts.sourceSender, calldata);
}

function validateRequest(request: CrossVaultRequest): string[] {
  const errors: string[] = [];
  if (!request.serviceType) errors.push("serviceType is required");
  if (!request.user || !isAddress(request.user)) errors.push("user must be a valid EVM address");
  if (!request.recipient || !isAddress(request.recipient)) errors.push("recipient must be a valid EVM address");
  if (!request.token || !isAddress(request.token)) errors.push("token must be a valid EVM address");
  if (!request.amount) errors.push("amount is required");
  if (!request.walletChainId) errors.push("walletChainId is required");
  if (!request.destinationChainId) errors.push("destinationChainId is required");
  if (!request.action) errors.push("action is required");
  if (!request.intent || !["DEPLOY", "REBALANCE", "WITHDRAW"].includes(request.intent)) {
    errors.push("intent must be DEPLOY|REBALANCE|WITHDRAW");
  }
  if (!request.executionMode || !["PLAN", "EXECUTE"].includes(request.executionMode)) {
    errors.push("executionMode must be PLAN|EXECUTE");
  }
  if (!request.riskProfile || !["LOW", "MEDIUM", "HIGH"].includes(request.riskProfile)) {
    errors.push("riskProfile must be LOW|MEDIUM|HIGH");
  }
  return errors;
}

async function handleCrossVaultRequest(
  runtime: Runtime<CrossVaultConfig>,
  request: CrossVaultRequest,
  requestId: string
): Promise<string> {
  const timestamp = runtime.now().toISOString();
  const confidential = resolveConfidentialContext(runtime.config, request);
  if (!request.serviceType) request.serviceType = "CROSSVAULT";

  const errors = validateRequest(request);
  if (errors.length > 0) {
    return JSON.stringify({
      success: false,
      requestId,
      timestamp,
      error: "Validation failed",
      details: errors
    });
  }

  runtime.log(`[${requestId}] CrossVault request: ${request.walletChainId} -> ${request.destinationChainId}`);
  if (confidential.enabled) {
    runtime.log(`[${requestId}] Confidential Compute active provider=${confidential.provider}`);
  }
  runtime.log(
    `[${requestId}] CrossVault runtime config serviceName=${runtime.config.serviceName} registry=${runtime.config.chainResolver?.registryAddressByChainId?.[String(request.walletChainId)] ?? "undefined"} selector=${runtime.config.chainResolver?.chainSelectorByChainId?.[String(request.walletChainId)] ?? "undefined"}`
  );

  const recommendationResult = resolveRecommendation(runtime, request);
  if (!recommendationResult.ok) {
    emitOpsLog(runtime, "recommendation_unavailable", {
      requestId,
      userReason: recommendationResult.userReason,
      internalReasonCode: recommendationResult.internalDecisionMeta.internalReasonCode ?? "",
      policyFlags: recommendationResult.internalDecisionMeta.policyFlags
    });

    return JSON.stringify({
      success: true,
      requestId,
      timestamp,
      data: {
        requestId,
        timestamp,
        status: "BLOCKED",
        resolver: {
          state: "BLOCKED",
          blockedReason: recommendationResult.userReason,
          sourceChainId: request.walletChainId,
          sourceChainName: "Pending Resolution",
          sourceChainSelector: "",
          destinationChainId: request.destinationChainId,
          destinationChainName: "Pending Resolution",
          destinationChainSelector: "",
          serviceType: request.serviceType,
          token: request.token.toLowerCase(),
          amount: request.amount,
          action: request.action,
          recipient: request.recipient.toLowerCase(),
          contracts: {}
        },
        preflight: {
          sourceChainSupported: false,
          destinationChainSupported: false,
          laneEnabled: false,
          contractsResolved: false,
          tokenMapped: false,
          amountParsed: false
        },
        security: {
          allow: false,
          enforcementMode: runtime.config.securityEnforcementMode,
          reasonCode: recommendationResult.userReason,
          incidentLogged: true
        },
        recommendation: {
          intent: request.intent,
          riskProfile: request.riskProfile,
          allocationModel: request.riskProfile === "LOW" ? "STABLE_HEAVY" : request.riskProfile === "HIGH" ? "GROWTH_HEAVY" : "BALANCED",
          rebalanceCadence: request.riskProfile === "LOW" ? "MONTHLY" : request.riskProfile === "HIGH" ? "WEEKLY" : "BIWEEKLY",
          slippageBpsCap: request.riskProfile === "LOW" ? 40 : request.riskProfile === "HIGH" ? 120 : 80,
          recommendedDestinationChainId: request.destinationChainId,
          protocol: "N/A",
          strategyAction: "vault",
          estimatedApyBps: 0,
          riskAssessment: request.riskProfile,
          confidence: 0,
          rationale: recommendationResult.userMessage
        },
        records: appendWorkflowRecords(
          requestId,
          request,
          "SECURITY_BLOCKED",
          runtime.config.feature5Enabled,
          "RECOMMENDATION_READY"
        ),
        execution: {
          submitted: false,
          message: recommendationResult.userMessage,
          reasonCode: recommendationResult.userReason
        },
        confidential: {
          mode: confidential.mode,
          enabled: confidential.enabled,
          provider: confidential.provider,
          flags: confidential.flags
        },
        notifications: runtime.config.notificationsEnabled ? ["CrossVault recommendation service temporarily unavailable."] : undefined
      }
    });
  }

  let recommendation = recommendationResult.publicRecommendation;
  const decisionMeta: RecommendationInternalMeta = recommendationResult.internalDecisionMeta;
  emitOpsLog(runtime, "recommendation_selected", {
    requestId,
    engine: decisionMeta.engine,
    usedFallback: decisionMeta.usedFallback,
    latencyMs: decisionMeta.latencyMs ?? 0,
    policyFlags: decisionMeta.policyFlags,
    internalReasonCode: decisionMeta.internalReasonCode ?? ""
  });

  let executionRequest: CrossVaultRequest = request;
  let overrideApplied = false;
  if (
    runtime.config.allowAiDestinationOverride &&
    recommendation.recommendedDestinationChainId > 0 &&
    recommendation.recommendedDestinationChainId !== request.destinationChainId
  ) {
    executionRequest = { ...request, destinationChainId: recommendation.recommendedDestinationChainId };
    overrideApplied = true;
    runtime.log(
      `[${requestId}] CrossVault destination override by recommendation: ${request.destinationChainId} -> ${executionRequest.destinationChainId}`
    );
  }

  let { resolved, preflight } = await resolveExecutionConfig(executionRequest, runtime.config, runtime);
  if (resolved.state === "BLOCKED" && overrideApplied) {
    emitOpsLog(runtime, "override_route_retry", {
      requestId,
      overriddenDestination: executionRequest.destinationChainId,
      originalDestination: request.destinationChainId,
      blockedReason: resolved.blockedReason ?? ""
    });

    const retried = await resolveExecutionConfig(request, runtime.config, runtime);
    if (retried.resolved.state !== "BLOCKED") {
      resolved = retried.resolved;
      preflight = retried.preflight;
      executionRequest = request;
      recommendation = {
        ...recommendation,
        recommendedDestinationChainId: request.destinationChainId,
        rationale: `${recommendation.rationale} Route adjusted to currently supported destination chain ${request.destinationChainId}.`
      };
      emitOpsLog(runtime, "override_route_adjusted", {
        requestId,
        effectiveDestination: request.destinationChainId
      });
    }
  }

  if (resolved.state === "BLOCKED") {
    const userReason = mapRouteBlockedReason(resolved.blockedReason);
    emitOpsLog(runtime, "route_blocked", {
      requestId,
      routeReason: resolved.blockedReason ?? "",
      userReason
    });
    const security: SecurityDecision = {
      allow: false,
      enforcementMode: runtime.config.securityEnforcementMode,
      reasonCode: userReason,
      incidentLogged: true
    };
    const records = appendWorkflowRecords(
      requestId,
      executionRequest,
      "SECURITY_BLOCKED",
      runtime.config.feature5Enabled,
      "RECOMMENDATION_READY"
    );
    const outcome: CrossVaultOutcome = {
      requestId,
      timestamp,
      status: "BLOCKED",
      resolver: resolved,
      preflight,
      security,
      recommendation,
      records,
      execution: { submitted: false, message: "Route is not currently supported for this request.", reasonCode: userReason },
      confidential: {
        mode: confidential.mode,
        enabled: confidential.enabled,
        provider: confidential.provider,
        flags: confidential.flags
      },
      notifications: runtime.config.notificationsEnabled ? [buildApprovalMessage(executionRequest, recommendation)] : []
    };
    return JSON.stringify({ success: true, requestId, timestamp, data: outcome });
  }

  let security = runSecurityChecks(executionRequest, runtime.config);
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

  const blockedBySecurity = (security.reasonCode?.startsWith("SECURITY_BLOCKED") ?? false) &&
    security.enforcementMode === "ENFORCE";
  if (blockedBySecurity) security = { ...security, allow: false };

  let fallbackPolicyBlockedReason: UserBlockedReason | undefined;
  let fallbackPolicyBlockedMessage: string | undefined;
  let approvalRequired = executionRequest.approvalRequired ?? runtime.config.requireExplicitApprovalForExecute;
  if (decisionMeta.engine !== "AI") {
    if (runtime.config.recommendationPolicy.fallbackRequireApproval) {
      approvalRequired = true;
    }
    try {
      if (BigInt(executionRequest.amount) > BigInt(runtime.config.recommendationPolicy.fallbackExecutionMaxAmountWei)) {
        fallbackPolicyBlockedReason = "POLICY_BLOCKED";
        fallbackPolicyBlockedMessage = "Execution amount exceeds fallback execution policy limit.";
        emitOpsLog(runtime, "fallback_policy_blocked", {
          requestId,
          reason: "FALLBACK_AMOUNT_LIMIT",
          amount: executionRequest.amount,
          max: runtime.config.recommendationPolicy.fallbackExecutionMaxAmountWei
        });
      }
    } catch {
      fallbackPolicyBlockedReason = "POLICY_BLOCKED";
      fallbackPolicyBlockedMessage = "Execution amount is invalid for fallback policy.";
      emitOpsLog(runtime, "fallback_policy_blocked", { requestId, reason: "FALLBACK_INVALID_AMOUNT" });
    }

    const allowed = runtime.config.recommendationPolicy.allowedProtocols;
    if (!fallbackPolicyBlockedReason && allowed.length > 0) {
      const ok = allowed.some((x) => x.toLowerCase() === recommendation.protocol.toLowerCase());
      if (!ok) {
        fallbackPolicyBlockedReason = "POLICY_BLOCKED";
        fallbackPolicyBlockedMessage = "Recommended protocol is not allowed by fallback policy.";
        emitOpsLog(runtime, "fallback_policy_blocked", {
          requestId,
          reason: "FALLBACK_PROTOCOL_NOT_ALLOWED",
          protocol: recommendation.protocol
        });
      }
    }
  }

  let execution: { submitted: boolean; message: string; txHash?: string; reasonCode?: string };
  if (fallbackPolicyBlockedReason) {
    execution = {
      submitted: false,
      message: fallbackPolicyBlockedMessage ?? "Execution blocked by policy.",
      reasonCode: fallbackPolicyBlockedReason
    };
  } else {
    execution = await executeServiceAction(runtime, resolved, executionRequest, security, recommendation, approvalRequired);
  }

  const securityPhase = security.allow ? "SECURITY_ALLOWED" : "SECURITY_BLOCKED";
  const approvalPhase = approvalRequired && !executionRequest.approved ? "APPROVAL_PENDING" : undefined;
  const executionPhase = execution.submitted ? "EXECUTION_SUBMITTED" : undefined;
  const records = appendWorkflowRecords(
    requestId,
    executionRequest,
    securityPhase,
    runtime.config.feature5Enabled,
    "RECOMMENDATION_READY",
    approvalPhase,
    executionPhase
  );

  const onchainPhases = ["REQUEST_RECEIVED", "PREFLIGHT_PASSED", securityPhase, "RECOMMENDATION_READY"];
  if (approvalPhase) onchainPhases.push(approvalPhase);
  if (executionPhase) onchainPhases.push(executionPhase);
  await appendWorkflowRecordsOnchain(runtime, resolved, executionRequest, requestId, onchainPhases, execution.txHash);

  const approvalMessage = buildApprovalMessage(executionRequest, recommendation);
  const notifications = runtime.config.notificationsEnabled
    ? [approvalMessage, `CrossVault execution=${execution.reasonCode ?? "UNKNOWN"} requestId=${requestId}`]
    : undefined;

  const status: CrossVaultOutcome["status"] = resolved.state === "READY" && security.allow ? "READY" : "BLOCKED";
  const outcome: CrossVaultOutcome = {
    requestId,
    timestamp,
    status,
    resolver: resolved,
    preflight,
    security,
    recommendation,
    records,
    approvalRequest: {
      required: approvalRequired,
      approved: Boolean(executionRequest.approved),
      message: approvalMessage
    },
    execution,
    confidential: {
      mode: confidential.mode,
      enabled: confidential.enabled,
      provider: confidential.provider,
      flags: confidential.flags
    },
    notifications
  };

  return JSON.stringify({ success: true, requestId, timestamp, data: outcome });
}

const onHttpCrossVault = async (
  runtime: Runtime<CrossVaultConfig>,
  payload: HTTPPayload
): Promise<string> => {
  let requestId = "cv_unset";
  try {
    if (!payload.input || payload.input.length === 0) {
      return JSON.stringify({
        success: false,
        requestId: "cv_empty_input",
        timestamp: runtime.now().toISOString(),
        error: "Empty request body"
      });
    }

    requestId = deterministicRequestId(payload.input);
    const request = decodeJson(payload.input) as CrossVaultRequest;
    return handleCrossVaultRequest(runtime, request, requestId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.log(`[${requestId}] CrossVault error: ${message}`);
    return JSON.stringify({ success: false, requestId, timestamp: runtime.now().toISOString(), error: message });
  }
};

const onCronCrossVault = async (runtime: Runtime<CrossVaultConfig>): Promise<string> => {
  if (!runtime.config.weeklyReviewEnabled) {
    return JSON.stringify({
      success: false,
      requestId: "cv_cron_disabled",
      timestamp: runtime.now().toISOString(),
      error: "weeklyReviewEnabled is false"
    });
  }

  const request = runtime.config.reviewRequest;
  if (!request) {
    return JSON.stringify({
      success: false,
      requestId: "cv_cron_missing_request",
      timestamp: runtime.now().toISOString(),
      error: "Missing reviewRequest in config"
    });
  }

  const requestId = toBytes32FromText(JSON.stringify(request)).slice(0, 10).replace("0x", "cv_");
  return handleCrossVaultRequest(runtime, request, requestId);
};

const initWorkflow = (config: CrossVaultConfig) => {
  validateRuntimeConfig(config);
  const handlers: unknown[] = [];

  if (config.weeklyReviewEnabled) {
    const cron = new cre.capabilities.CronCapability();
    handlers.push(cre.handler(cron.trigger({ schedule: config.schedule }), onCronCrossVault));
  }

  const httpCapability = new cre.capabilities.HTTPCapability();
  const configuredKeys = (config.authorizedEVMAddresses ?? [])
    .filter((addr) => isAddress(addr))
    .map((addr) => ({
      type: "KEY_TYPE_ECDSA_EVM" as const,
      publicKey: addr
    }));

  const httpTrigger = configuredKeys.length > 0
    ? httpCapability.trigger({ authorizedKeys: configuredKeys })
    : httpCapability.trigger({});

  handlers.push(cre.handler(httpTrigger, onHttpCrossVault));
  return handlers;
};

export async function main() {
  const runner = await Runner.newRunner<CrossVaultConfig>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("CrossVault workflow failed:", error);
  process.exit(1);
});
