import { createPublicClient, encodeFunctionData, http, isAddress, parseAbi, parseUnits } from "viem"
import {
  CHAINS,
  CONFIDENTIAL_COMPUTE,
  AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
  AUTOMATED_TRADER_RECEIVER_BY_DEST_CHAIN_ID,
  TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID,
  TOKEN_TRANSFER_RECEIVER_BY_DEST_CHAIN_ID,
  PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID,
  PROGRAMMABLE_TOKEN_RECEIVER_BY_DEST_CHAIN_ID,
  CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
  LINK_TOKEN_BY_CHAIN_ID,
  DESTINATION_BY_CHAIN_ID,
  SUPPORTED_SOURCE_CHAINS_BY_ACTION,
  type ChainKey,
  type Address,
} from "../config.js"
import type { ConfidentialIntentMeta, IntentBuildRequest, PreparedTransaction } from "../../shared/intents.js"

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
])

const TRADER_ABI = parseAbi([
  "function createTimedOrder(uint256 intervalSeconds,address token,uint256 amount,uint64 destinationChain,address receiverContract,address recipient,string action,bool recurring,uint256 maxExecutions,uint256 deadline) external returns (uint256)",
  "function pauseOrder(uint256 orderId, bool paused) external",
  "function cancelOrder(uint256 orderId) external",
])

const ALERT_ABI = parseAbi([
  "function upsertRule(uint256 ruleId, uint8 alertType, bool enabled, uint32 cooldownSeconds, uint32 rearmSeconds, string paramsJson) external returns (uint256)",
  "function setRuleEnabled(uint256 ruleId, bool enabled) external",
])

const TOKEN_TRANSFER_SENDER_ABI = parseAbi([
  "function transferTokensPayLink(uint64 destinationChainSelector, address receiver, address token, uint256 amount) external returns (bytes32)",
  "function estimateFee(uint64 destinationChainSelector, address receiver, address token, uint256 amount) external view returns (uint256)",
])

const PROGRAMMABLE_SENDER_ABI = parseAbi([
  "function sendPayLink(uint64 destinationChainSelector, address receiverContract, address token, uint256 amount, (address,string,bytes,uint256) payload) external returns (bytes32)",
  "function estimateFee(uint64 destinationChainSelector, address receiverContract, address token, uint256 amount, (address,string,bytes,uint256) payload) external view returns (uint256)",
])

const AUTO_LINK_TOPUP_ENABLED =
  (process.env.ORCHESTRATOR_AUTO_LINK_TOPUP ?? "true").toLowerCase() !== "false"
const LINK_TOPUP_BUFFER_BPS = resolveBps(process.env.ORCHESTRATOR_LINK_TOPUP_BUFFER_BPS, 11_000)
const MIN_LINK_TOPUP_WEI = resolveBigInt(process.env.ORCHESTRATOR_MIN_LINK_TOPUP_WEI, 0n)

const clientsByChainId = new Map<number, ReturnType<typeof createPublicClient>>()

function asAddress(input: unknown, field: string): `0x${string}` {
  if (typeof input !== "string" || !isAddress(input)) {
    throw new Error(`Invalid ${field}: expected 0x address`)
  }
  return input as `0x${string}`
}

function asString(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new Error(`Invalid ${field}: expected non-empty string`)
  }
  return input
}

function asBool(input: unknown, field: string, fallback?: boolean): boolean {
  if (typeof input === "boolean") return input
  if (fallback !== undefined) return fallback
  throw new Error(`Invalid ${field}: expected boolean`)
}

function asBigIntFromAny(
  raw: unknown,
  field: string,
  opts?: { fallback?: bigint; decimals?: number; humanField?: unknown }
): bigint {
  if (typeof raw === "bigint") return raw
  if (typeof raw === "number") return BigInt(raw)
  if (typeof raw === "string" && raw.trim().length > 0) {
    if (raw.includes(".")) {
      return parseUnits(raw, opts?.decimals ?? 18)
    }
    return BigInt(raw)
  }
  if (opts?.humanField !== undefined) {
    if (typeof opts.humanField !== "string" || opts.humanField.trim().length === 0) {
      throw new Error(`Invalid ${field}: amount is missing`)
    }
    return parseUnits(opts.humanField, opts?.decimals ?? 18)
  }
  if (opts?.fallback !== undefined) return opts.fallback
  throw new Error(`Invalid ${field}`)
}

function asNumber(input: unknown, field: string, fallback?: number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input
  if (typeof input === "string" && input.trim().length > 0) return Number(input)
  if (fallback !== undefined) return fallback
  throw new Error(`Invalid ${field}: expected number`)
}

function resolveDestinationChain(params: Record<string, unknown>): ChainKey {
  const byKey = params.destinationChainKey
  if (typeof byKey === "string" && byKey in CHAINS) {
    return byKey as ChainKey
  }

  const byId = asNumber(params.destinationChainId, "destinationChainId", -1)
  const resolved = DESTINATION_BY_CHAIN_ID[byId]
  if (!resolved) throw new Error(`Unsupported destination chainId: ${byId}`)
  return resolved
}

function toHexValue(value: bigint): `0x${string}` {
  return `0x${value.toString(16)}` as `0x${string}`
}

function resolveBps(raw: string | undefined, fallback: number): bigint {
  const parsed = Number(raw ?? fallback)
  if (!Number.isFinite(parsed) || parsed < 10_000) return BigInt(fallback)
  return BigInt(Math.floor(parsed))
}

function resolveBigInt(raw: string | undefined, fallback: bigint): bigint {
  if (!raw) return fallback
  try {
    return BigInt(raw)
  } catch {
    return fallback
  }
}

function getPublicClientForChain(chainId: number) {
  const existing = clientsByChainId.get(chainId)
  if (existing) return existing

  const chain = Object.values(CHAINS).find((c) => c.chainId === chainId)
  if (!chain) throw new Error(`Unsupported chainId ${chainId}`)

  const client = createPublicClient({
    transport: http(chain.rpcUrl),
  })
  clientsByChainId.set(chainId, client)
  return client
}

function resolveChainMappedAddress(
  map: Record<number, Address>,
  chainId: number,
  label: string
): `0x${string}` {
  const address = map[chainId]
  if (!address) {
    throw new Error(`${label} is not configured for chainId ${chainId}`)
  }
  return address
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function resolveConfidentialMeta(params: Record<string, unknown>): ConfidentialIntentMeta {
  const raw = asRecord(params.__confidential)
  if (!raw) {
    return {
      enabled: CONFIDENTIAL_COMPUTE.enabledByDefault,
      strict: CONFIDENTIAL_COMPUTE.strict,
      provider: CONFIDENTIAL_COMPUTE.provider,
      tokenApiBaseUrl: CONFIDENTIAL_COMPUTE.tokenApiBaseUrl,
      hideSender: CONFIDENTIAL_COMPUTE.hideSenderDefault,
    }
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : CONFIDENTIAL_COMPUTE.enabledByDefault,
    strict: typeof raw.strict === "boolean" ? raw.strict : CONFIDENTIAL_COMPUTE.strict,
    provider:
      raw.provider === "CONVERGENCE_2026_TOKEN_API"
        ? "CONVERGENCE_2026_TOKEN_API"
        : CONFIDENTIAL_COMPUTE.provider,
    tokenApiBaseUrl:
      typeof raw.tokenApiBaseUrl === "string" && raw.tokenApiBaseUrl.length > 0
        ? raw.tokenApiBaseUrl
        : CONFIDENTIAL_COMPUTE.tokenApiBaseUrl,
    hideSender: typeof raw.hideSender === "boolean" ? raw.hideSender : CONFIDENTIAL_COMPUTE.hideSenderDefault,
  }
}

function describe(base: string, confidential: ConfidentialIntentMeta): string {
  if (!confidential.enabled) return base
  return `[Confidential] ${base}`
}

function applyFeeBuffer(fee: bigint): bigint {
  return (fee * LINK_TOPUP_BUFFER_BPS + 9_999n) / 10_000n
}

async function getLinkBalance(
  chainId: number,
  owner: `0x${string}`,
  linkTokenAddress: `0x${string}`
): Promise<bigint> {
  const client = getPublicClientForChain(chainId)
  return client.readContract({
    address: linkTokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  })
}

async function buildAutoLinkTopUpTxs(
  sourceChainId: number,
  senderContract: `0x${string}`,
  feeEstimate: bigint,
  linkTokenAddress: `0x${string}`
): Promise<PreparedTransaction[]> {
  if (!AUTO_LINK_TOPUP_ENABLED) return []

  const balance = await getLinkBalance(sourceChainId, senderContract, linkTokenAddress)
  const required = applyFeeBuffer(feeEstimate)
  if (balance >= required) return []

  let deficit = required - balance
  if (deficit < MIN_LINK_TOPUP_WEI) deficit = MIN_LINK_TOPUP_WEI

  return [
    tx(
      sourceChainId,
      linkTokenAddress,
      encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [senderContract, deficit],
      }),
      `Auto-fund sender LINK for CCIP fee (${deficit.toString()} wei)`
    ),
  ]
}

function tx(
  chainId: number,
  to: `0x${string}`,
  data: `0x${string}`,
  description: string,
  value?: bigint
): PreparedTransaction {
  const chain = Object.values(CHAINS).find((c) => c.chainId === chainId)
  if (!chain) throw new Error(`Unsupported chainId ${chainId}`)
  return {
    txId: crypto.randomUUID(),
    chainId,
    chainIdHex: chain.chainIdHex as `0x${string}`,
    to,
    data,
    value: toHexValue(value ?? 0n),
    description,
  }
}

export async function buildTransactions(request: IntentBuildRequest): Promise<PreparedTransaction[]> {
  const p = request.params ?? {}
  const confidential = resolveConfidentialMeta(p)
  const sourceChainId = asNumber(p.sourceChainId, "sourceChainId", CHAINS.sepolia.chainId)
  const sourceChain = Object.values(CHAINS).find((c) => c.chainId === sourceChainId)
  if (!sourceChain) {
    throw new Error(`Unsupported source chainId: ${sourceChainId}`)
  }
  const allowedSourceChains = SUPPORTED_SOURCE_CHAINS_BY_ACTION[request.action] ?? []
  if (!allowedSourceChains.includes(sourceChainId)) {
    throw new Error(
      `Action ${request.action} is not enabled for chainId ${sourceChainId}. Supported: ${allowedSourceChains.join(", ")}`
    )
  }

  switch (request.action) {
    case "DCA_CREATE_TIMED_ORDER": {
      const token = asAddress(p.token, "token")
      const recipient = asAddress(p.recipient, "recipient")
      const action = asString(p.action, "action")
      const destinationKey = resolveDestinationChain(p)
      const destinationChainId = CHAINS[destinationKey].chainId
      const destinationSelector = CHAINS[destinationKey].selector
      const intervalSeconds = BigInt(asNumber(p.intervalSeconds, "intervalSeconds"))
      const maxExecutions = BigInt(asNumber(p.maxExecutions, "maxExecutions", 0))
      const recurring = asBool(p.recurring, "recurring", true)
      const deadlineUnix = BigInt(asNumber(p.deadlineUnix, "deadlineUnix", 0))
      const automatedTrader = resolveChainMappedAddress(
        AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "AutomatedTrader"
      )
      const defaultReceiver = resolveChainMappedAddress(
        AUTOMATED_TRADER_RECEIVER_BY_DEST_CHAIN_ID,
        destinationChainId,
        "AutomatedTraderReceiver"
      )
      const receiverContract = asAddress(
        p.receiverContract ?? defaultReceiver,
        "receiverContract"
      )
      const amount = asBigIntFromAny(p.amountWei, "amountWei", {
        humanField: p.amount,
        decimals: asNumber(p.tokenDecimals, "tokenDecimals", 18),
      })

      return [
        tx(
          sourceChainId,
          automatedTrader,
          encodeFunctionData({
            abi: TRADER_ABI,
            functionName: "createTimedOrder",
            args: [
              intervalSeconds,
              token,
              amount,
              destinationSelector,
              receiverContract,
              recipient,
              action,
              recurring,
              maxExecutions,
              deadlineUnix,
            ],
          }),
          describe(`DCA create timed order (${action})`, confidential)
        ),
      ]
    }

    case "DCA_SET_ORDER_PAUSED": {
      const orderId = BigInt(asNumber(p.orderId, "orderId"))
      const paused = asBool(p.paused, "paused")
      const automatedTrader = resolveChainMappedAddress(
        AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "AutomatedTrader"
      )
      return [
        tx(
          sourceChainId,
          automatedTrader,
          encodeFunctionData({
            abi: TRADER_ABI,
            functionName: "pauseOrder",
            args: [orderId, paused],
          }),
          describe(paused ? `Pause DCA order #${orderId}` : `Resume DCA order #${orderId}`, confidential)
        ),
      ]
    }

    case "DCA_CANCEL_ORDER": {
      const orderId = BigInt(asNumber(p.orderId, "orderId"))
      const automatedTrader = resolveChainMappedAddress(
        AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "AutomatedTrader"
      )
      return [
        tx(
          sourceChainId,
          automatedTrader,
          encodeFunctionData({
            abi: TRADER_ABI,
            functionName: "cancelOrder",
            args: [orderId],
          }),
          describe(`Cancel DCA order #${orderId}`, confidential)
        ),
      ]
    }

    case "DCA_FUND_LINK": {
      const amount = asBigIntFromAny(p.amountWei, "amountWei", {
        humanField: p.amount,
        decimals: asNumber(p.tokenDecimals, "tokenDecimals", 18),
      })
      const automatedTrader = resolveChainMappedAddress(
        AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "AutomatedTrader"
      )
      const linkToken = resolveChainMappedAddress(LINK_TOKEN_BY_CHAIN_ID, sourceChainId, "LINK token")
      const to = asAddress(p.to ?? automatedTrader, "to")
      return [
        tx(
          sourceChainId,
          linkToken,
          encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [to, amount],
          }),
          describe(`Fund ${to === automatedTrader ? "AutomatedTrader" : "target contract"} with LINK`, confidential)
        ),
      ]
    }

    case "CHAINALERT_UPSERT_RULE": {
      const ruleId = BigInt(asNumber(p.ruleId, "ruleId", 0))
      const alertType = asNumber(p.alertType, "alertType")
      const enabled = asBool(p.enabled, "enabled", true)
      const cooldown = asNumber(p.cooldownSeconds, "cooldownSeconds", 3600)
      const rearm = asNumber(p.rearmSeconds, "rearmSeconds", 0)
      const paramsJson =
        typeof p.paramsJson === "string"
          ? p.paramsJson
          : JSON.stringify((p.paramsObject ?? {}) as Record<string, unknown>)
      const chainAlertRegistry = resolveChainMappedAddress(
        CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "ChainAlertRegistry"
      )

      return [
        tx(
          sourceChainId,
          chainAlertRegistry,
          encodeFunctionData({
            abi: ALERT_ABI,
            functionName: "upsertRule",
            args: [ruleId, alertType, enabled, cooldown, rearm, paramsJson],
          }),
          describe(ruleId === 0n ? "Create ChainAlert rule" : `Update ChainAlert rule #${ruleId}`, confidential)
        ),
      ]
    }

    case "CHAINALERT_SET_RULE_ENABLED": {
      const ruleId = BigInt(asNumber(p.ruleId, "ruleId"))
      const enabled = asBool(p.enabled, "enabled")
      const chainAlertRegistry = resolveChainMappedAddress(
        CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "ChainAlertRegistry"
      )
      return [
        tx(
          sourceChainId,
          chainAlertRegistry,
          encodeFunctionData({
            abi: ALERT_ABI,
            functionName: "setRuleEnabled",
            args: [ruleId, enabled],
          }),
          describe(`${enabled ? "Enable" : "Disable"} ChainAlert rule #${ruleId}`, confidential)
        ),
      ]
    }

    case "CHAINSHIELD_TRANSFER": {
      const destinationKey = resolveDestinationChain(p)
      const destinationChainId = CHAINS[destinationKey].chainId
      const token = asAddress(p.token, "token")
      const recipient = asAddress(p.recipient, "recipient")
      const amount = asBigIntFromAny(p.amountWei, "amountWei", {
        humanField: p.amount,
        decimals: asNumber(p.tokenDecimals, "tokenDecimals", 18),
      })
      const selector = CHAINS[destinationKey].selector
      const tokenTransferSender = resolveChainMappedAddress(
        TOKEN_TRANSFER_SENDER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "TokenTransferSender"
      )
      const configuredReceiver = TOKEN_TRANSFER_RECEIVER_BY_DEST_CHAIN_ID[destinationChainId]
      const receiver = asAddress(
        p.receiverContract ?? configuredReceiver ?? recipient,
        "receiverContract"
      )
      const linkToken = resolveChainMappedAddress(LINK_TOKEN_BY_CHAIN_ID, sourceChainId, "LINK token")
      const client = getPublicClientForChain(sourceChainId)
      const feeEstimate = await client.readContract({
        address: tokenTransferSender,
        abi: TOKEN_TRANSFER_SENDER_ABI,
        functionName: "estimateFee",
        args: [selector, receiver, token, amount],
      })
      const fundingTxs = await buildAutoLinkTopUpTxs(
        sourceChainId,
        tokenTransferSender,
        feeEstimate,
        linkToken
      )

      return [
        ...fundingTxs,
        tx(
          sourceChainId,
          token,
          encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [tokenTransferSender, amount],
          }),
          describe("Approve token for ChainShield sender", confidential)
        ),
        tx(
          sourceChainId,
          tokenTransferSender,
          encodeFunctionData({
            abi: TOKEN_TRANSFER_SENDER_ABI,
            functionName: "transferTokensPayLink",
            args: [selector, receiver, token, amount],
          }),
          describe(`ChainShield transfer to ${CHAINS[destinationKey].name}`, confidential)
        ),
      ]
    }

    case "CROSSVAULT_DEPOSIT": {
      const destinationKey = resolveDestinationChain(p)
      const destinationChainId = CHAINS[destinationKey].chainId
      const token = asAddress(p.token, "token")
      const recipient = asAddress(p.recipient, "recipient")
      const amount = asBigIntFromAny(p.amountWei, "amountWei", {
        humanField: p.amount,
        decimals: asNumber(p.tokenDecimals, "tokenDecimals", 18),
      })
      const selector = CHAINS[destinationKey].selector
      const action = asString(p.action ?? "deposit", "action")
      const deadlineUnix = BigInt(asNumber(p.deadlineUnix, "deadlineUnix", Math.floor(Date.now() / 1000) + 86400 * 7))
      const extraData =
        typeof p.extraDataHex === "string" && p.extraDataHex.startsWith("0x")
          ? (p.extraDataHex as `0x${string}`)
          : ("0x" as `0x${string}`)
      const receiverContract = asAddress(
        p.receiverContract ??
          resolveChainMappedAddress(
            PROGRAMMABLE_TOKEN_RECEIVER_BY_DEST_CHAIN_ID,
            destinationChainId,
            "ProgrammableTokenReceiver"
          ),
        "receiverContract"
      )
      const programmableTokenSender = resolveChainMappedAddress(
        PROGRAMMABLE_TOKEN_SENDER_BY_SOURCE_CHAIN_ID,
        sourceChainId,
        "ProgrammableTokenSender"
      )
      const linkToken = resolveChainMappedAddress(LINK_TOKEN_BY_CHAIN_ID, sourceChainId, "LINK token")
      const payload: readonly [ `0x${string}`, string, `0x${string}`, bigint ] = [
        recipient,
        action,
        extraData,
        deadlineUnix,
      ]
      const client = getPublicClientForChain(sourceChainId)
      const feeEstimate = await client.readContract({
        address: programmableTokenSender,
        abi: PROGRAMMABLE_SENDER_ABI,
        functionName: "estimateFee",
        args: [selector, receiverContract, token, amount, payload],
      })
      const fundingTxs = await buildAutoLinkTopUpTxs(
        sourceChainId,
        programmableTokenSender,
        feeEstimate,
        linkToken
      )

      return [
        ...fundingTxs,
        tx(
          sourceChainId,
          token,
          encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [programmableTokenSender, amount],
          }),
          describe("Approve token for CrossVault programmable sender", confidential)
        ),
        tx(
          sourceChainId,
          programmableTokenSender,
          encodeFunctionData({
            abi: PROGRAMMABLE_SENDER_ABI,
            functionName: "sendPayLink",
            args: [
              selector,
              receiverContract,
              token,
              amount,
              payload,
            ],
          }),
          describe(`CrossVault ${action} to ${CHAINS[destinationKey].name}`, confidential)
        ),
      ]
    }

    default:
      throw new Error(`Unsupported action: ${request.action}`)
  }
}
