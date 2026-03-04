import {
  cre,
  encodeCallMsg,
  LATEST_BLOCK_NUMBER,
  bytesToHex,
  type Runtime
} from "@chainlink/cre-sdk";
import { decodeFunctionResult, encodeFunctionData, keccak256, toBytes } from "viem";
import type {
  BlockedReason,
  ChainResolverRuntimeConfig,
  PreflightReport,
  ResolveRequest,
  ResolvedContracts,
  ResolvedExecutionConfig,
  ResolutionState
} from "./chain-resolver.types";

const CHAIN_REGISTRY_ABI = [
  {
    type: "function",
    name: "getSelectorByChainId",
    stateMutability: "view",
    inputs: [{ name: "chainId", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }]
  },
  {
    type: "function",
    name: "isChainSupported",
    stateMutability: "view",
    inputs: [{ name: "selector", type: "uint64" }],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "isLaneActive",
    stateMutability: "view",
    inputs: [
      { name: "sourceSelector", type: "uint64" },
      { name: "destinationSelector", type: "uint64" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "isTokenTransferable",
    stateMutability: "view",
    inputs: [
      { name: "sourceSelector", type: "uint64" },
      { name: "destinationSelector", type: "uint64" },
      { name: "sourceToken", type: "address" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "getServiceContract",
    stateMutability: "view",
    inputs: [
      { name: "chainSelector", type: "uint64" },
      { name: "serviceKey", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "address" }]
  }
] as const;

type ServiceBindings = { source: string; destination?: string };

const DEFAULT_SERVICE_BINDINGS: Record<string, ServiceBindings> = {
  CHAINSHIELD_TRANSFER: { source: "TOKEN_TRANSFER_SENDER", destination: "TOKEN_TRANSFER_RECEIVER" },
  TOKEN_TRANSFER: { source: "TOKEN_TRANSFER_SENDER", destination: "TOKEN_TRANSFER_RECEIVER" },
  PROGRAMMABLE_TRANSFER: {
    source: "PROGRAMMABLE_TRANSFER_SENDER",
    destination: "PROGRAMMABLE_TRANSFER_RECEIVER"
  },
  MESSAGE: { source: "MESSAGE_SENDER", destination: "MESSAGE_RECEIVER" },
  DCA: { source: "AUTOMATED_TRADER", destination: "PROGRAMMABLE_TRANSFER_RECEIVER" },
  AUTOMATED_TRADER: { source: "AUTOMATED_TRADER", destination: "PROGRAMMABLE_TRANSFER_RECEIVER" },
  CROSSVAULT: { source: "PROGRAMMABLE_TRANSFER_SENDER", destination: "PROGRAMMABLE_TRANSFER_RECEIVER" }
};

interface ChainMeta {
  chainId: number;
  selector: string;
  name: string;
  isActive: boolean;
}

function chainNameFromConfig(config: ChainResolverRuntimeConfig, chainId: number): string {
  const configured = config.chainResolver.chainNameByChainId?.[String(chainId)];
  if (configured && configured.trim().length > 0) return configured;
  return `chain-${chainId}`;
}

interface CachedResolution {
  expiresAt: number;
  value: { resolved: ResolvedExecutionConfig; preflight: PreflightReport };
}

const resolutionCache = new Map<string, CachedResolution>();

function normalizeAddress(input: string): string {
  return input.toLowerCase();
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function pseudoEstimateFeeWei(amountWei: bigint, sourceChainId: number, destinationChainId: number): bigint {
  const base = 30_000_000_000_000_000n;
  const variable = amountWei / 1_000_000_000n;
  const distance = BigInt(Math.abs(sourceChainId - destinationChainId) % 1000);
  return base + variable + distance * 1_000_000_000_000n;
}

function serviceTypeKey(serviceType: string): string {
  return serviceType.trim().toUpperCase();
}

function blocked(
  request: ResolveRequest,
  reason: BlockedReason,
  source: Partial<ChainMeta>,
  destination: Partial<ChainMeta>,
  contracts: ResolvedContracts = {}
): { resolved: ResolvedExecutionConfig; preflight: PreflightReport } {
  return {
    resolved: {
      state: "BLOCKED",
      blockedReason: reason,
      sourceChainId: request.walletChainId,
      sourceChainName: source.name ?? "Unsupported",
      sourceChainSelector: source.selector ?? "",
      destinationChainId: request.destinationChainId,
      destinationChainName: destination.name ?? "Unsupported",
      destinationChainSelector: destination.selector ?? "",
      serviceType: request.serviceType,
      token: request.token,
      amount: request.amount,
      action: request.action,
      recipient: request.recipient,
      contracts
    },
    preflight: {
      sourceChainSupported: Boolean(source.isActive),
      destinationChainSupported: Boolean(destination.isActive),
      laneEnabled: false,
      contractsResolved: false,
      tokenMapped: false,
      amountParsed: false
    }
  };
}

async function callRegistry<T>(
  runtime: Runtime<ChainResolverRuntimeConfig>,
  registryAddress: string,
  sourceSelector: bigint,
  functionName: string,
  args: readonly unknown[]
): Promise<T> {
  const evmClient = new cre.capabilities.EVMClient(sourceSelector);
  const data = encodeFunctionData({ abi: CHAIN_REGISTRY_ABI, functionName, args });
  const out = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: registryAddress as `0x${string}`,
        to: registryAddress as `0x${string}`,
        data
      }),
      blockNumber: LATEST_BLOCK_NUMBER
    })
    .result();

  return decodeFunctionResult({
    abi: CHAIN_REGISTRY_ABI,
    functionName,
    data: bytesToHex(out.data)
  }) as T;
}

export async function loadChainMeta(
  config: ChainResolverRuntimeConfig,
  runtime: Runtime<ChainResolverRuntimeConfig>,
  sourceRegistryAddress: string,
  sourceBootstrapSelector: bigint,
  chainId: number
): Promise<ChainMeta | null> {
  let selector: bigint;
  try {
    selector = await callRegistry<bigint>(
      runtime,
      sourceRegistryAddress,
      sourceBootstrapSelector,
      "getSelectorByChainId",
      [BigInt(chainId)]
    );
  } catch (error) {
    runtime.log(
      `[resolver] getSelectorByChainId failed chainId=${chainId} registry=${sourceRegistryAddress} selector=${sourceBootstrapSelector.toString()} error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }

  if (selector === 0n) {
    runtime.log(`[resolver] getSelectorByChainId returned 0 for chainId=${chainId}`);
    return null;
  }

  try {
    const isSupported = await callRegistry<boolean>(
      runtime,
      sourceRegistryAddress,
      sourceBootstrapSelector,
      "isChainSupported",
      [selector]
    );
    if (!isSupported) {
      runtime.log(`[resolver] isChainSupported returned false selector=${selector.toString()} chainId=${chainId}`);
      return null;
    }
    return {
      chainId,
      selector: selector.toString(),
      name: chainNameFromConfig(config, chainId),
      isActive: true
    };
  } catch (error) {
    runtime.log(
      `[resolver] isChainSupported failed selector=${selector.toString()} chainId=${chainId} error=${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export async function resolveServiceContracts(
  runtime: Runtime<ChainResolverRuntimeConfig>,
  request: ResolveRequest,
  sourceRegistryAddress: string,
  sourceBootstrapSelector: bigint,
  sourceSelector: string,
  destinationSelector: string
): Promise<ResolvedContracts> {
  const serviceKey = serviceTypeKey(request.serviceType);
  const binding = DEFAULT_SERVICE_BINDINGS[serviceKey];
  if (!binding) return {};

  const sourceService = await callRegistry<`0x${string}`>(
    runtime,
    sourceRegistryAddress,
    sourceBootstrapSelector,
    "getServiceContract",
    [BigInt(sourceSelector), keccak256Text(binding.source)]
  );

  const destinationService = binding.destination
    ? await callRegistry<`0x${string}`>(
        runtime,
        sourceRegistryAddress,
        sourceBootstrapSelector,
        "getServiceContract",
        [BigInt(destinationSelector), keccak256Text(binding.destination)]
      )
    : undefined;

  const contracts: ResolvedContracts = {
    securityManager: runtime.config.securityManagerContract,
    tokenVerifier: runtime.config.tokenVerifierContract,
    userRecordRegistry: runtime.config.userRecordRegistryContract
  };

  if (serviceKey === "DCA" || serviceKey === "AUTOMATED_TRADER") {
    if (isAddress(sourceService)) contracts.automatedTrader = sourceService;
    if (destinationService && isAddress(destinationService)) contracts.destinationReceiver = destinationService;
  } else {
    if (isAddress(sourceService)) contracts.sourceSender = sourceService;
    if (destinationService && isAddress(destinationService)) contracts.destinationReceiver = destinationService;
  }

  return contracts;
}

function keccak256Text(value: string): `0x${string}` {
  return keccak256(toBytes(value));
}

export async function resolveExecutionConfig(
  request: ResolveRequest,
  config: ChainResolverRuntimeConfig,
  runtime: Runtime<ChainResolverRuntimeConfig>
): Promise<{ resolved: ResolvedExecutionConfig; preflight: PreflightReport }> {
  const cacheKey = `${request.walletChainId}:${request.destinationChainId}:${request.serviceType}:${request.token}:${request.amount}:${request.action}:${request.recipient}`;
  const now = Date.now();
  const ttl = config.chainResolver.cacheTtlMs ?? 0;
  if (ttl > 0) {
    const cached = resolutionCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const registryAddress = config.chainResolver.registryAddressByChainId[String(request.walletChainId)];
  const bootstrapSelector = config.chainResolver.chainSelectorByChainId[String(request.walletChainId)];

  if (!registryAddress || !isAddress(registryAddress) || !bootstrapSelector) {
    runtime.log(
      `[resolver] missing bootstrap config walletChainId=${request.walletChainId} registry=${registryAddress ?? "undefined"} selector=${bootstrapSelector ?? "undefined"}`
    );
    return blocked(request, "CHAIN_UNSUPPORTED", {}, {});
  }

  const sourceBootstrap = BigInt(bootstrapSelector);
  const source = await loadChainMeta(config, runtime, registryAddress, sourceBootstrap, request.walletChainId);
  const destination = await loadChainMeta(config, runtime, registryAddress, sourceBootstrap, request.destinationChainId);

  if (!source || !destination || !source.isActive || !destination.isActive) {
    return blocked(request, "CHAIN_UNSUPPORTED", source ?? {}, destination ?? {});
  }

  const preflight: PreflightReport = {
    sourceChainSupported: true,
    destinationChainSupported: true,
    laneEnabled: false,
    contractsResolved: false,
    tokenMapped: false,
    amountParsed: false
  };

  const laneActive = await callRegistry<boolean>(
    runtime,
    registryAddress,
    sourceBootstrap,
    "isLaneActive",
    [BigInt(source.selector), BigInt(destination.selector)]
  );
  preflight.laneEnabled = laneActive;

  if (!laneActive) {
    return blocked(request, "LANE_DISABLED", source, destination);
  }

  let amount: bigint;
  try {
    amount = BigInt(request.amount);
    preflight.amountParsed = amount > 0n;
  } catch {
    return blocked(request, "FEE_ESTIMATION_FAILED", source, destination);
  }

  if (!isAddress(request.token)) {
    return blocked(request, "TOKEN_MAPPING_MISSING", source, destination);
  }

  const tokenMapped = await callRegistry<boolean>(
    runtime,
    registryAddress,
    sourceBootstrap,
    "isTokenTransferable",
    [BigInt(source.selector), BigInt(destination.selector), request.token as `0x${string}`]
  );
  preflight.tokenMapped = tokenMapped;
  if (!tokenMapped) {
    return blocked(request, "TOKEN_MAPPING_MISSING", source, destination);
  }

  const contracts = await resolveServiceContracts(
    runtime,
    request,
    registryAddress,
    sourceBootstrap,
    source.selector,
    destination.selector
  );

  const serviceKey = serviceTypeKey(request.serviceType);
  const contractsResolved =
    serviceKey === "DCA" || serviceKey === "AUTOMATED_TRADER"
      ? Boolean(contracts.automatedTrader)
      : Boolean(contracts.sourceSender && contracts.destinationReceiver);

  preflight.contractsResolved = contractsResolved;

  const estimatedFeeWei = pseudoEstimateFeeWei(amount, source.chainId, destination.chainId).toString();
  preflight.estimatedFeeWei = estimatedFeeWei;

  const state: ResolutionState = contractsResolved ? "READY" : "DEGRADED";
  const result = {
    resolved: {
      state,
      degradedReason: contractsResolved ? undefined : "Service contracts are not fully bound in ChainRegistry",
      sourceChainId: source.chainId,
      sourceChainName: source.name,
      sourceChainSelector: source.selector,
      destinationChainId: destination.chainId,
      destinationChainName: destination.name,
      destinationChainSelector: destination.selector,
      serviceType: request.serviceType,
      token: normalizeAddress(request.token),
      amount: request.amount,
      action: request.action,
      recipient: normalizeAddress(request.recipient),
      contracts,
      estimatedFeeWei
    },
    preflight
  };

  if (ttl > 0) {
    resolutionCache.set(cacheKey, { expiresAt: now + ttl, value: result });
  }

  return result;
}
