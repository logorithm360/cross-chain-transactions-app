// cli/contracts/reader.ts
// All read-only on-chain calls.
// Returns typed data — screens consume this and never call viem directly.

import { createPublicClient, http, parseAbi, type PublicClient } from "viem"
import { CONTRACTS, CHAINS } from "../config.js"
import type { WalletSession }  from "../wallet/connector.js"

// ─── DCA Status enum (mirrors Solidity) ──────────────────────────────────────

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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrderSnapshot {
  orderId:                   bigint
  owner:                     string
  triggerType:               number
  dcaStatus:                 number
  isReadyToExecute:          boolean
  isFunded:                  boolean
  estimatedFeePerExecution:  bigint
  executionsRemainingFunded: bigint
  token:                     string
  amount:                    bigint
  destinationChain:          bigint
  recipient:                 string
  action:                    string
  interval:                  bigint
  createdAt:                 bigint
  lastExecutedAt:            bigint
  nextExecutionAt:           bigint
  deadline:                  bigint
  executionCount:            bigint
  maxExecutions:             bigint
  recurring:                 boolean
  contractLinkBalance:       bigint
  contractTokenBalance:      bigint
  lastPendingMessageIds:     readonly [string, string, string]
  lastCompletedMessageIds:   readonly [string, string, string]
  lastFailedMessageIds:      readonly [string, string, string]
}

export interface AlertRule {
  ruleId:          bigint
  owner:           string
  ruleType:        string
  params:          string    // JSON-encoded rule parameters
  status:          string    // WATCHING | TRIGGERED | COOLING_DOWN | PAUSED
  lastTriggeredAt: bigint
  triggerCount:    bigint
  cooldownSeconds: bigint
  isActive:        boolean
}

// ─── ABIs (minimal — only what the CLI reads) ────────────────────────────────

const TRADER_ABI = parseAbi([
  "function getUserOrders(address user) view returns (tuple(uint256 orderId, address owner, uint8 triggerType, uint8 dcaStatus, bool isReadyToExecute, bool isFunded, uint256 estimatedFeePerExecution, uint256 executionsRemainingFunded, address token, uint256 amount, uint64 destinationChain, address recipient, string action, uint256 interval, uint256 createdAt, uint256 lastExecutedAt, uint256 nextExecutionAt, uint256 deadline, uint256 executionCount, uint256 maxExecutions, bool recurring, uint256 contractLinkBalance, uint256 contractTokenBalance, bytes32[3] lastPendingMessageIds, bytes32[3] lastCompletedMessageIds, bytes32[3] lastFailedMessageIds)[])",
  "function getOrderSnapshot(uint256 orderId) view returns (tuple(uint256 orderId, address owner, uint8 triggerType, uint8 dcaStatus, bool isReadyToExecute, bool isFunded, uint256 estimatedFeePerExecution, uint256 executionsRemainingFunded, address token, uint256 amount, uint64 destinationChain, address recipient, string action, uint256 interval, uint256 createdAt, uint256 lastExecutedAt, uint256 nextExecutionAt, uint256 deadline, uint256 executionCount, uint256 maxExecutions, bool recurring, uint256 contractLinkBalance, uint256 contractTokenBalance, bytes32[3] lastPendingMessageIds, bytes32[3] lastCompletedMessageIds, bytes32[3] lastFailedMessageIds))",
])

const LINK_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
])

const ALERT_REGISTRY_ABI = parseAbi([
  "function getUserRules(address user) view returns (tuple(uint256 ruleId, address owner, string ruleType, string params, string status, uint256 lastTriggeredAt, uint256 triggerCount, uint256 cooldownSeconds, bool isActive)[])",
  "function getAlertHistory(address user, uint256 limit) view returns (tuple(uint256 alertId, uint256 ruleId, string ruleType, uint256 triggeredAt, string headline, string explanation, uint8 severity)[])",
])

// ─── Client factory ───────────────────────────────────────────────────────────

function client(session: WalletSession): PublicClient {
  return session.publicClient
}

// ─── DCA reads ────────────────────────────────────────────────────────────────

export async function getUserOrders(session: WalletSession): Promise<OrderSnapshot[]> {
  const result = await client(session).readContract({
    address:      CONTRACTS.automatedTrader as `0x${string}`,
    abi:          TRADER_ABI,
    functionName: "getUserOrders",
    args:         [session.address],
  })
  return result as unknown as OrderSnapshot[]
}

export async function getOrderSnapshot(
  session:  WalletSession,
  orderId:  bigint
): Promise<OrderSnapshot> {
  const result = await client(session).readContract({
    address:      CONTRACTS.automatedTrader as `0x${string}`,
    abi:          TRADER_ABI,
    functionName: "getOrderSnapshot",
    args:         [orderId],
  })
  return result as unknown as OrderSnapshot
}

// ─── LINK balance reads ───────────────────────────────────────────────────────

export async function getLinkBalance(
  session: WalletSession,
  address?: `0x${string}`
): Promise<bigint> {
  return client(session).readContract({
    address:      CONTRACTS.linkToken as `0x${string}`,
    abi:          LINK_ABI,
    functionName: "balanceOf",
    args:         [address ?? session.address],
  }) as Promise<bigint>
}

export async function getLinkAllowance(
  session: WalletSession,
  spender: `0x${string}`
): Promise<bigint> {
  return client(session).readContract({
    address:      CONTRACTS.linkToken as `0x${string}`,
    abi:          LINK_ABI,
    functionName: "allowance",
    args:         [session.address, spender],
  }) as Promise<bigint>
}

// ─── Alert registry reads ─────────────────────────────────────────────────────

export async function getUserAlertRules(session: WalletSession): Promise<AlertRule[]> {
  const result = await client(session).readContract({
    address:      CONTRACTS.chainAlertRegistry as `0x${string}`,
    abi:          ALERT_REGISTRY_ABI,
    functionName: "getUserRules",
    args:         [session.address],
  })
  return result as unknown as AlertRule[]
}

export async function getAlertHistory(
  session: WalletSession,
  limit:   number = 10
): Promise<unknown[]> {
  const result = await client(session).readContract({
    address:      CONTRACTS.chainAlertRegistry as `0x${string}`,
    abi:          ALERT_REGISTRY_ABI,
    functionName: "getAlertHistory",
    args:         [session.address, BigInt(limit)],
  })
  return result as unknown[]
}

// ─── Native ETH balance ───────────────────────────────────────────────────────

export async function getEthBalance(
  session: WalletSession,
  address?: `0x${string}`
): Promise<bigint> {
  return client(session).getBalance({ address: address ?? session.address })
}
