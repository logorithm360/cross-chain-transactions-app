import { parseAbi, type PublicClient } from "viem"
import {
  AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
  CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
  CONTRACTS,
  LINK_TOKEN_BY_CHAIN_ID,
  type Address,
} from "../config.js"
import type { WalletSession } from "../wallet/connector.js"

export const DCA_STATUS_LABELS: Record<number, string> = {
  0: "Pending first execution",
  1: "Scheduled",
  2: "Awaiting condition",
  3: "Paused by owner",
  4: "Paused by AI",
  5: "Insufficient funds",
  6: "Completed",
  7: "Expired",
  8: "Cancelled",
}

export interface OrderSnapshot {
  orderId: bigint
  owner: string
  triggerType: number
  dcaStatus: number
  isReadyToExecute: boolean
  isFunded: boolean
  estimatedFeePerExecution: bigint
  executionsRemainingFunded: bigint
  token: string
  amount: bigint
  destinationChain: bigint
  recipient: string
  action: string
  interval: bigint
  createdAt: bigint
  lastExecutedAt: bigint
  nextExecutionAt: bigint
  deadline: bigint
  executionCount: bigint
  maxExecutions: bigint
  recurring: boolean
  contractLinkBalance: bigint
  contractTokenBalance: bigint
  lastPendingMessageIds: readonly [string, string, string]
  lastCompletedMessageIds: readonly [string, string, string]
  lastFailedMessageIds: readonly [string, string, string]
}

export interface AlertRule {
  ruleId: bigint
  owner: string
  alertType: number
  ruleType: string
  params: string
  status: string
  lastTriggeredAt: bigint
  triggerCount: bigint
  cooldownSeconds: bigint
  rearmSeconds: bigint
  isActive: boolean
}

const ALERT_TYPE_LABELS: Record<number, string> = {
  0: "PORTFOLIO_DROP_PERCENT",
  1: "PORTFOLIO_DROP_ABSOLUTE",
  2: "TOKEN_CONCENTRATION",
  3: "TOKEN_FLAGGED_SUSPICIOUS",
  4: "TOKEN_PRICE_SPIKE",
  5: "TOKEN_LIQUIDITY_DROP",
  6: "TOKEN_HOLDER_CONCENTRATION",
  7: "DCA_ORDER_FAILED",
  8: "DCA_LOW_FUNDS",
  9: "DCA_ORDER_PAUSED_BY_AI",
  10: "DCA_EXECUTION_STUCK",
  11: "WALLET_LARGE_OUTFLOW",
  12: "WALLET_INTERACTION_WITH_FLAGGED",
  13: "WALLET_NEW_TOKEN_RECEIVED",
}

const TRADER_ABI = parseAbi([
  "function getUserOrders(address user) view returns ((uint256,address,uint8,uint8,bool,bool,uint256,uint256,address,uint256,uint64,address,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,bytes32[3],bytes32[3],bytes32[3])[])",
  "function getOrderSnapshot(uint256 orderId) view returns ((uint256,address,uint8,uint8,bool,bool,uint256,uint256,address,uint256,uint64,address,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,uint256,uint256,bytes32[3],bytes32[3],bytes32[3]))",
])

const LINK_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
])

const ALERT_ABI = parseAbi([
  "function getUserRuleIds(address owner) view returns (uint256[])",
  "function getRule(uint256 ruleId) view returns ((uint256,address,uint8,bool,uint32,uint32,string,uint64,uint64))",
  "function getRuleState(uint256 ruleId) view returns ((bool,uint64,uint64,uint64,int256,bytes32,uint32))",
])

function client(session: WalletSession): PublicClient {
  return session.publicClient
}

function resolveChainMappedAddress(
  map: Record<number, Address>,
  chainId: number,
  fallback: Address
): `0x${string}` {
  return (map[chainId] ?? fallback) as `0x${string}`
}

export function resolveAutomatedTraderAddress(session: WalletSession): `0x${string}` {
  return resolveChainMappedAddress(
    AUTOMATED_TRADER_BY_SOURCE_CHAIN_ID,
    session.chainId,
    CONTRACTS.automatedTrader
  )
}

function resolveLinkTokenAddress(session: WalletSession): `0x${string}` {
  return resolveChainMappedAddress(
    LINK_TOKEN_BY_CHAIN_ID,
    session.chainId,
    CONTRACTS.linkToken
  )
}

function resolveChainAlertRegistryAddress(session: WalletSession): `0x${string}` {
  return resolveChainMappedAddress(
    CHAINALERT_REGISTRY_BY_SOURCE_CHAIN_ID,
    session.chainId,
    CONTRACTS.chainAlertRegistry
  )
}

function readField(raw: unknown, key: string, index: number): unknown {
  if (raw && typeof raw === "object" && key in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>)[key]
  }
  if (Array.isArray(raw)) return raw[index]
  return undefined
}

function asBigInt(raw: unknown, fallback: bigint = 0n): bigint {
  if (typeof raw === "bigint") return raw
  if (typeof raw === "number") return BigInt(raw)
  if (typeof raw === "string" && raw.length > 0) {
    try {
      return BigInt(raw)
    } catch {
      return fallback
    }
  }
  return fallback
}

function asNumber(raw: unknown, fallback: number = 0): number {
  if (typeof raw === "number") return raw
  if (typeof raw === "bigint") return Number(raw)
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

function asBool(raw: unknown, fallback: boolean = false): boolean {
  if (typeof raw === "boolean") return raw
  return fallback
}

function asString(raw: unknown, fallback: string = ""): string {
  return typeof raw === "string" ? raw : fallback
}

function asTriplet(raw: unknown): readonly [string, string, string] {
  const zero = "0x0000000000000000000000000000000000000000000000000000000000000000"
  if (!Array.isArray(raw)) return [zero, zero, zero]
  return [
    asString(raw[0], zero),
    asString(raw[1], zero),
    asString(raw[2], zero),
  ] as const
}

function toOrderSnapshot(raw: unknown): OrderSnapshot {
  return {
    orderId: asBigInt(readField(raw, "orderId", 0)),
    owner: asString(readField(raw, "owner", 1)),
    triggerType: asNumber(readField(raw, "triggerType", 2)),
    dcaStatus: asNumber(readField(raw, "dcaStatus", 3)),
    isReadyToExecute: asBool(readField(raw, "isReadyToExecute", 4)),
    isFunded: asBool(readField(raw, "isFunded", 5)),
    estimatedFeePerExecution: asBigInt(readField(raw, "estimatedFeePerExecution", 6)),
    executionsRemainingFunded: asBigInt(readField(raw, "executionsRemainingFunded", 7)),
    token: asString(readField(raw, "token", 8)),
    amount: asBigInt(readField(raw, "amount", 9)),
    destinationChain: asBigInt(readField(raw, "destinationChain", 10)),
    recipient: asString(readField(raw, "recipient", 11)),
    action: asString(readField(raw, "action", 12)),
    interval: asBigInt(readField(raw, "interval", 13)),
    createdAt: asBigInt(readField(raw, "createdAt", 14)),
    lastExecutedAt: asBigInt(readField(raw, "lastExecutedAt", 15)),
    nextExecutionAt: asBigInt(readField(raw, "nextExecutionAt", 16)),
    deadline: asBigInt(readField(raw, "deadline", 17)),
    executionCount: asBigInt(readField(raw, "executionCount", 18)),
    maxExecutions: asBigInt(readField(raw, "maxExecutions", 19)),
    recurring: asBool(readField(raw, "recurring", 20)),
    contractLinkBalance: asBigInt(readField(raw, "contractLinkBalance", 21)),
    contractTokenBalance: asBigInt(readField(raw, "contractTokenBalance", 22)),
    lastPendingMessageIds: asTriplet(readField(raw, "lastPendingMessageIds", 23)),
    lastCompletedMessageIds: asTriplet(readField(raw, "lastCompletedMessageIds", 24)),
    lastFailedMessageIds: asTriplet(readField(raw, "lastFailedMessageIds", 25)),
  }
}

export async function getUserOrders(session: WalletSession): Promise<OrderSnapshot[]> {
  const result = await client(session).readContract({
    address: resolveAutomatedTraderAddress(session),
    abi: TRADER_ABI,
    functionName: "getUserOrders",
    args: [session.address],
  })
  return (result as unknown[]).map(toOrderSnapshot)
}

export async function getOrderSnapshot(session: WalletSession, orderId: bigint): Promise<OrderSnapshot> {
  const result = await client(session).readContract({
    address: resolveAutomatedTraderAddress(session),
    abi: TRADER_ABI,
    functionName: "getOrderSnapshot",
    args: [orderId],
  })
  return toOrderSnapshot(result)
}

export async function getLinkBalance(session: WalletSession, address?: `0x${string}`): Promise<bigint> {
  return client(session).readContract({
    address: resolveLinkTokenAddress(session),
    abi: LINK_ABI,
    functionName: "balanceOf",
    args: [address ?? session.address],
  }) as Promise<bigint>
}

export async function getLinkAllowance(session: WalletSession, spender: `0x${string}`): Promise<bigint> {
  return client(session).readContract({
    address: resolveLinkTokenAddress(session),
    abi: LINK_ABI,
    functionName: "allowance",
    args: [session.address, spender],
  }) as Promise<bigint>
}

export async function getUserAlertRules(session: WalletSession): Promise<AlertRule[]> {
  const chainAlertRegistry = resolveChainAlertRegistryAddress(session)
  const ids = (await client(session).readContract({
    address: chainAlertRegistry,
    abi: ALERT_ABI,
    functionName: "getUserRuleIds",
    args: [session.address],
  })) as bigint[]

  const rows = await Promise.all(
    ids.map(async (ruleId) => {
      const rule = (await client(session).readContract({
        address: chainAlertRegistry,
        abi: ALERT_ABI,
        functionName: "getRule",
        args: [ruleId],
      })) as unknown as [bigint, string, number, boolean, number, number, string, bigint, bigint]

      const state = (await client(session).readContract({
        address: chainAlertRegistry,
        abi: ALERT_ABI,
        functionName: "getRuleState",
        args: [ruleId],
      })) as unknown as [boolean, bigint, bigint, bigint, bigint, string, number]

      const enabled = Boolean(rule[3])
      const active = Boolean(state[0])
      const status = enabled ? (active ? "TRIGGERED" : "WATCHING") : "PAUSED"

      const out: AlertRule = {
        ruleId: rule[0],
        owner: rule[1],
        alertType: Number(rule[2]),
        ruleType: ALERT_TYPE_LABELS[Number(rule[2])] ?? `TYPE_${rule[2]}`,
        params: rule[6],
        status,
        lastTriggeredAt: state[2],
        triggerCount: BigInt(state[6]),
        cooldownSeconds: BigInt(rule[4]),
        rearmSeconds: BigInt(rule[5]),
        isActive: enabled,
      }
      return out
    })
  )

  return rows.sort((a, b) => Number(a.ruleId - b.ruleId))
}

export async function getAlertHistory(_session: WalletSession, _limit: number = 10): Promise<unknown[]> {
  // ChainAlertRegistry tracks state and events, but there is no direct history getter.
  // v1 CLI keeps this empty and relies on rule/status views.
  return []
}

export async function getEthBalance(session: WalletSession, address?: `0x${string}`): Promise<bigint> {
  return client(session).getBalance({ address: address ?? session.address })
}
