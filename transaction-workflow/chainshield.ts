import {
  cre,
  Runner,
  prepareReportRequest,
  bytesToHex,
  encodeCallMsg,
  LAST_FINALIZED_BLOCK_NUMBER,
  LATEST_BLOCK_NUMBER,
  type Runtime,
  type HTTPPayload,
  decodeJson
} from "@chainlink/cre-sdk";
import { encodeFunctionData, decodeFunctionResult, keccak256, toBytes, type Hex } from "viem";
import { resolveExecutionConfig as resolveExecutionConfigFromRegistry } from "./chain-resolver";
import { resolveConfidentialContext } from "./confidential.compute";

type ResolutionState = "READY" | "BLOCKED" | "DEGRADED";
type EnforcementMode = "MONITOR" | "ENFORCE";

type BlockedReason =
  | "CHAIN_UNSUPPORTED"
  | "LANE_DISABLED"
  | "CONTRACT_NOT_DEPLOYED"
  | "TOKEN_MAPPING_MISSING"
  | "SECURITY_BLOCKED"
  | "FEE_ESTIMATION_FAILED"
  | "FINALITY_DELAYED";

interface ResolveRequest {
  walletChainId: number;
  destinationChainId: number;
  serviceType: string;
  user: string;
  recipient: string;
  token: string;
  amount: string;
  action: string;
  confidentialMode?: boolean;
  confidentialFlags?: string[];
}

interface ResolvedExecutionConfig {
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

interface PreflightReport {
  sourceChainSupported: boolean;
  destinationChainSupported: boolean;
  laneEnabled: boolean;
  contractsResolved: boolean;
  tokenMapped: boolean;
  amountParsed: boolean;
  estimatedFeeWei?: string;
}

interface SecurityDecision {
  allow: boolean;
  enforcementMode: EnforcementMode;
  reasonCode?: string;
  incidentLogged: boolean;
}

interface WorkflowRecord {
  phase: string;
  externalEventKey: string;
  status: string;
  metadataHash: string;
}

interface WorkflowOutcome {
  requestId: string;
  timestamp: string;
  status: ResolutionState | "EXECUTION_SUBMITTED";
  resolver: ResolvedExecutionConfig;
  preflight: PreflightReport;
  security: SecurityDecision;
  records: WorkflowRecord[];
  execution: {
    submitted: boolean;
    message: string;
    txHash?: string;
  };
  confidential?: {
    mode: "CONFIDENTIAL" | "PUBLIC";
    enabled: boolean;
    provider: string;
    flags: string[];
  };
}

interface ChainShieldConfig {
  serviceName: string;
  authorizedEVMAddresses?: string[];
  feature5Enabled: boolean;
  feature6Enabled: boolean;
  securityEnforcementMode: EnforcementMode;
  maxTransferAmountWei: string;
  tokenAllowlist: string[];
  tokenBlocklist: string[];
  enabledLaneKeys: string[];
  sourceSenderByChainId: Record<string, string>;
  destinationReceiverByChainId: Record<string, string>;
  securityManagerContract?: string;
  tokenVerifierContract?: string;
  userRecordRegistryContract?: string;
  sourceChainWriteGasLimit?: string;
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
}

function normalizeAddress(input: string): string {
  return input.toLowerCase();
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}


function mapToMetadataHash(input: ResolveRequest): string {
  const raw = `${input.user}|${input.token}|${input.amount}|${input.action}|${input.walletChainId}|${input.destinationChainId}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) >>> 0;
  }
  return `0x${hash.toString(16).padStart(64, "0")}`;
}

function deterministicRequestId(payload: Uint8Array): string {
  const raw = new TextDecoder().decode(payload);
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 33 + raw.charCodeAt(i)) >>> 0;
  }
  return `cs_${hash.toString(16).padStart(8, "0")}`;
}

async function resolveExecutionConfig(
  request: ResolveRequest,
  config: ChainShieldConfig,
  runtime: Runtime<ChainShieldConfig>
): Promise<{ resolved: ResolvedExecutionConfig; preflight: PreflightReport }> {
  return (await resolveExecutionConfigFromRegistry(request, config, runtime)) as {
    resolved: ResolvedExecutionConfig;
    preflight: PreflightReport;
  };
}

function runSecurityChecks(request: ResolveRequest, config: ChainShieldConfig): SecurityDecision {
  const mode = config.securityEnforcementMode;
  const token = normalizeAddress(request.token);

  if (!config.feature6Enabled) {
    return { allow: true, enforcementMode: mode, reasonCode: "SECURITY_DISABLED", incidentLogged: false };
  }

  if (config.tokenBlocklist.map(normalizeAddress).includes(token)) {
    const shouldBlock = mode === "ENFORCE";
    return {
      allow: !shouldBlock,
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TOKEN_BLOCKLISTED",
      incidentLogged: true
    };
  }

  if (config.tokenAllowlist.length > 0 && !config.tokenAllowlist.map(normalizeAddress).includes(token)) {
    const shouldBlock = mode === "ENFORCE";
    return {
      allow: !shouldBlock,
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TOKEN_NOT_ALLOWLISTED",
      incidentLogged: true
    };
  }

  let amount = 0n;
  try {
    amount = BigInt(request.amount);
  } catch {
    const shouldBlock = mode === "ENFORCE";
    return {
      allow: !shouldBlock,
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:INVALID_AMOUNT",
      incidentLogged: true
    };
  }

  const max = BigInt(config.maxTransferAmountWei);
  if (amount > max) {
    const shouldBlock = mode === "ENFORCE";
    return {
      allow: !shouldBlock,
      enforcementMode: mode,
      reasonCode: "SECURITY_BLOCKED:TRANSFER_LIMIT",
      incidentLogged: true
    };
  }

  return {
    allow: true,
    enforcementMode: mode,
    reasonCode: "SECURITY_ALLOWED",
    incidentLogged: false
  };
}

function appendWorkflowRecords(requestId: string, request: ResolveRequest, status: string, feature5Enabled: boolean): WorkflowRecord[] {
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

  return [
    { phase: "REQUEST_RECEIVED", externalEventKey: `${keyBase}:request`, status: "PENDING_APPEND", metadataHash },
    { phase: "PREFLIGHT_PASSED", externalEventKey: `${keyBase}:preflight`, status: "PENDING_APPEND", metadataHash },
    { phase: status, externalEventKey: `${keyBase}:security`, status: "PENDING_APPEND", metadataHash }
  ];
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

function mapFeatureType(serviceType: string): number {
  const key = serviceTypeKey(serviceType);
  if (key === "MESSAGE") return 0;
  if (key === "TOKEN_TRANSFER" || key === "CHAINSHIELD_TRANSFER") return 1;
  if (key === "PROGRAMMABLE_TRANSFER") return 2;
  return 3;
}

function mapRecordStatus(phase: string): number {
  if (phase === "REQUEST_RECEIVED") return 0; // CREATED
  if (phase === "PREFLIGHT_PASSED") return 1; // SENT
  if (phase === "SECURITY_ALLOWED") return 1; // SENT
  if (phase === "EXECUTION_SUBMITTED") return 1; // SENT
  if (phase === "SECURITY_BLOCKED") return 5; // FAILED
  return 5;
}

async function readOnchainSecurityState(
  runtime: Runtime<ChainShieldConfig>,
  resolved: ResolvedExecutionConfig
): Promise<{ paused: boolean; enforcementMode: EnforcementMode; tokenStatus?: number }> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  let paused = false;
  let enforcementMode: EnforcementMode = "MONITOR";
  let tokenStatus: number | undefined = undefined;

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
          from: resolved.contracts.sourceSender as `0x${string}`,
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
          from: resolved.contracts.sourceSender as `0x${string}`,
          to: resolved.contracts.tokenVerifier as `0x${string}`,
          data: callData
        }),
        blockNumber: LATEST_BLOCK_NUMBER
      })
      .result();

    const decoded = decodeFunctionResult({
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

    tokenStatus = decoded;
  }

  return { paused, enforcementMode, tokenStatus };
}

async function appendWorkflowRecordsOnchain(
  runtime: Runtime<ChainShieldConfig>,
  resolved: ResolvedExecutionConfig,
  request: ResolveRequest,
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
  const featureType = mapFeatureType(resolved.serviceType);
  const actionHash = keccak256(toBytes(request.action));
  const metadataHash = mapToMetadataHash(request) as Hex;
  const messageId = toBytes32OrZero(txHash);

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
        gasConfig: { gasLimit: runtime.config.sourceChainWriteGasLimit ?? "800000" }
      })
      .result();
  }
}

function serviceTypeKey(serviceType: string): string {
  return serviceType.trim().toUpperCase();
}

async function submitSourceChainWrite(
  runtime: Runtime<ChainShieldConfig>,
  resolved: ResolvedExecutionConfig,
  to: string,
  calldata: Hex
): Promise<{ submitted: boolean; message: string; txHash?: string }> {
  const sourceSelector = BigInt(resolved.sourceChainSelector);
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const report = runtime.report(prepareReportRequest(calldata)).result();
  const gasLimit = runtime.config.sourceChainWriteGasLimit ?? "700000";
  const write = evmClient
    .writeReport(runtime, {
      receiver: to as Hex,
      report,
      gasConfig: { gasLimit }
    })
    .result();

  // txHash is bytes in response; convert when available.
  const txHashBytes = write.txHash;
  const txHash = txHashBytes && txHashBytes.length > 0 ? bytesToHex(txHashBytes) : undefined;
  return {
    submitted: true,
    message: "Source chain transaction submitted via CRE EVM write capability",
    txHash
  };
}

async function executeServiceAction(
  runtime: Runtime<ChainShieldConfig>,
  resolved: ResolvedExecutionConfig,
  security: SecurityDecision
): Promise<{ submitted: boolean; message: string; txHash?: string }> {
  if (!security.allow) {
    return {
      submitted: false,
      message: "Execution blocked by Feature 6 security policy"
    };
  }

  if (resolved.state !== "READY") {
    return {
      submitted: false,
      message: "Execution adapter is waiting for full chain contract config"
    };
  }

  if (!resolved.contracts.sourceSender) {
    return { submitted: false, message: "Missing source sender contract address" };
  }
  if (!resolved.contracts.destinationReceiver) {
    return { submitted: false, message: "Missing destination receiver contract address" };
  }

  const normalizedService = serviceTypeKey(resolved.serviceType);
  const sender = resolved.contracts.sourceSender;
  const destinationSelector = BigInt(resolved.destinationChainSelector);
  const receiver = resolved.contracts.destinationReceiver;
  const token = resolved.token;
  const amount = BigInt(resolved.amount);

  // Feature 2 style route
  if (normalizedService === "TOKEN_TRANSFER" || normalizedService === "CHAINSHIELD_TRANSFER") {
    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "transferTokensPayLink",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_destinationChainSelector", type: "uint64" },
            { name: "_receiver", type: "address" },
            { name: "_token", type: "address" },
            { name: "_amount", type: "uint256" }
          ],
          outputs: [{ name: "messageId", type: "bytes32" }]
        }
      ],
      functionName: "transferTokensPayLink",
      args: [destinationSelector, receiver as `0x${string}`, token as `0x${string}`, amount]
    });

    return submitSourceChainWrite(runtime, resolved, sender, calldata);
  }

  // Feature 3 style route
  if (normalizedService === "PROGRAMMABLE_TRANSFER") {
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
        destinationSelector,
        receiver as `0x${string}`,
        token as `0x${string}`,
        amount,
        {
          recipient: resolved.recipient as `0x${string}`,
          action: resolved.action,
          extraData: "0x",
          deadline: 0n
        }
      ]
    });

    return submitSourceChainWrite(runtime, resolved, sender, calldata);
  }

  // Feature 1 style route
  if (normalizedService === "MESSAGE") {
    const calldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "sendMessagePayLink",
          stateMutability: "nonpayable",
          inputs: [
            { name: "_destinationChainSelector", type: "uint64" },
            { name: "_receiver", type: "address" },
            { name: "_text", type: "string" }
          ],
          outputs: [{ name: "messageId", type: "bytes32" }]
        }
      ],
      functionName: "sendMessagePayLink",
      args: [destinationSelector, receiver as `0x${string}`, resolved.action]
    });

    return submitSourceChainWrite(runtime, resolved, sender, calldata);
  }

  return { submitted: false, message: `Unsupported serviceType: ${resolved.serviceType}` };
}

function validateRequest(request: ResolveRequest): string[] {
  const errors: string[] = [];

  if (!request.serviceType) errors.push("serviceType is required");
  if (!request.action) errors.push("action is required");
  if (!request.user || !isAddress(request.user)) errors.push("user must be a valid EVM address");
  if (!request.recipient || !isAddress(request.recipient)) errors.push("recipient must be a valid EVM address");
  if (!request.token || !isAddress(request.token)) errors.push("token must be a valid EVM address");
  if (!request.amount) errors.push("amount is required");
  if (!request.walletChainId) errors.push("walletChainId is required");
  if (!request.destinationChainId) errors.push("destinationChainId is required");

  return errors;
}

const onHttpChainShield = async (
  runtime: Runtime<ChainShieldConfig>,
  payload: HTTPPayload
): Promise<string> => {
  let requestId = "cs_unset";
  let timestamp = runtime.now().toISOString();
  try {
    if (!payload.input || payload.input.length === 0) {
      return JSON.stringify({
        success: false,
        requestId: "cs_empty_input",
        timestamp: runtime.now().toISOString(),
        error: "Empty request body"
      });
    }

    requestId = deterministicRequestId(payload.input);
    timestamp = runtime.now().toISOString();
    const request = decodeJson(payload.input) as ResolveRequest;
    const confidential = resolveConfidentialContext(runtime.config, request);
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

    runtime.log(`[${requestId}] ChainShield request: ${request.walletChainId} -> ${request.destinationChainId}`);
    if (confidential.enabled) {
      runtime.log(`[${requestId}] Confidential Compute active provider=${confidential.provider}`);
    }

    const { resolved, preflight } = await resolveExecutionConfig(request, runtime.config, runtime);

    if (resolved.state === "BLOCKED") {
      const security = {
        allow: false,
        enforcementMode: runtime.config.securityEnforcementMode,
        reasonCode: resolved.blockedReason,
        incidentLogged: true
      } as SecurityDecision;

      const records = appendWorkflowRecords(requestId, request, "SECURITY_BLOCKED", runtime.config.feature5Enabled);
      const outcome: WorkflowOutcome = {
        requestId,
        timestamp,
        status: "BLOCKED",
        resolver: resolved,
        preflight,
        security,
        records,
        execution: { submitted: false, message: "No execution attempted" },
        confidential: {
          mode: confidential.mode,
          enabled: confidential.enabled,
          provider: confidential.provider,
          flags: confidential.flags
        }
      };

      return JSON.stringify({ success: true, requestId, timestamp, data: outcome });
    }

    let security = runSecurityChecks(request, runtime.config);
    let onchainMode: EnforcementMode | undefined;
    let onchainTokenStatus: number | undefined;
    let onchainPaused = false;
    if (runtime.config.feature6Enabled) {
      const onchainSec = await readOnchainSecurityState(runtime, resolved);
      onchainMode = onchainSec.enforcementMode;
      onchainTokenStatus = onchainSec.tokenStatus;
      onchainPaused = onchainSec.paused;
      // Fail-closed preference: if either config or on-chain indicates ENFORCE, use ENFORCE.
      if (runtime.config.securityEnforcementMode === "ENFORCE" || onchainSec.enforcementMode === "ENFORCE") {
        security.enforcementMode = "ENFORCE";
      }
      if (onchainSec.paused) {
        security = {
          allow: onchainSec.enforcementMode === "MONITOR",
          enforcementMode: onchainSec.enforcementMode,
          reasonCode: "SECURITY_BLOCKED:PAUSED",
          incidentLogged: true
        };
      } else if (onchainSec.tokenStatus === 6) { // BLOCKLISTED
        security = {
          allow: onchainSec.enforcementMode === "MONITOR",
          enforcementMode: onchainSec.enforcementMode,
          reasonCode: "SECURITY_BLOCKED:TOKEN_BLOCKLISTED",
          incidentLogged: true
        };
      }
    }

    // Final strict rule: blocked reason cannot pass in ENFORCE mode.
    const isBlockedReason = security.reasonCode?.startsWith("SECURITY_BLOCKED") ?? false;
    if (isBlockedReason && security.enforcementMode === "ENFORCE") {
      security = { ...security, allow: false };
    }

    runtime.log(
      `[${requestId}] Security decision mode=${security.enforcementMode} allow=${security.allow} reason=${security.reasonCode ?? "n/a"} onchainMode=${onchainMode ?? "n/a"} tokenStatus=${onchainTokenStatus ?? -1} paused=${onchainPaused}`
    );

    const securityPhase = security.reasonCode?.startsWith("SECURITY_BLOCKED")
      ? "SECURITY_BLOCKED"
      : (security.allow ? "SECURITY_ALLOWED" : "SECURITY_BLOCKED");
    const records = appendWorkflowRecords(requestId, request, securityPhase, runtime.config.feature5Enabled);
    const execution = await executeServiceAction(runtime, resolved, security);

    const onchainPhases = ["REQUEST_RECEIVED", "PREFLIGHT_PASSED", securityPhase];
    if (execution.submitted) onchainPhases.push("EXECUTION_SUBMITTED");
    await appendWorkflowRecordsOnchain(runtime, resolved, request, requestId, onchainPhases, execution.txHash);

    const finalStatus: WorkflowOutcome["status"] = security.allow ? "DEGRADED" : "BLOCKED";
    const status = resolved.state === "READY" && security.allow ? "READY" : finalStatus;

    const outcome: WorkflowOutcome = {
      requestId,
      timestamp,
      status,
      resolver: resolved,
      preflight,
      security,
      records,
      execution,
      confidential: {
        mode: confidential.mode,
        enabled: confidential.enabled,
        provider: confidential.provider,
        flags: confidential.flags
      }
    };

    return JSON.stringify({ success: true, requestId, timestamp, data: outcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.log(`[${requestId}] ChainShield error: ${message}`);
    return JSON.stringify({ success: false, requestId, timestamp, error: message });
  }
};

const initWorkflow = (_config: ChainShieldConfig) => {
  const httpCapability = new cre.capabilities.HTTPCapability();
  const configuredKeys = (_config.authorizedEVMAddresses ?? [])
    .filter((addr) => isAddress(addr))
    .map((addr) => ({
      type: "KEY_TYPE_ECDSA_EVM" as const,
      publicKey: addr
    }));

  // Empty config is valid in simulation; authorized keys are required for deployment.
  const httpTrigger = configuredKeys.length > 0
    ? httpCapability.trigger({ authorizedKeys: configuredKeys })
    : httpCapability.trigger({});
  return [cre.handler(httpTrigger, onHttpChainShield)];
};

export async function main() {
  const runner = await Runner.newRunner<ChainShieldConfig>();
  await runner.run(initWorkflow);
}

main().catch((error: unknown) => {
  console.log("ChainShield workflow failed:", error);
  process.exit(1);
});
