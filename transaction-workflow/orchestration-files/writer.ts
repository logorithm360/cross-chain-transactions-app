// cli/contracts/writer.ts
// All state-changing on-chain calls.
// Every function shows a spinner, sends the tx, waits for confirmation,
// and returns the transaction hash.

import {
  parseAbi,
  parseEther,
  parseUnits,
  type Hash,
} from "viem"
import ora      from "ora"
import { CONTRACTS, CHAINS }    from "../config.js"
import type { WalletSession }   from "../wallet/connector.js"
import { errorBox, successBox } from "../utils/display.js"

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const TRADER_ABI = parseAbi([
  "function createTimedOrder(address token, uint256 amount, uint64 destinationChain, address recipient, string calldata action, uint256 interval, uint256 maxExecutions, bool recurring, uint256 deadline) external returns (uint256 orderId)",
  "function createPriceOrder(address token, uint256 amount, uint64 destinationChain, address recipient, string calldata action, uint256 targetPrice, bool executeBelow, uint256 maxExecutions) external returns (uint256 orderId)",
  "function pauseOrder(uint256 orderId) external",
  "function resumeOrder(uint256 orderId) external",
  "function cancelOrder(uint256 orderId) external",
])

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
])

const ALERT_REGISTRY_ABI = parseAbi([
  "function createRule(string calldata ruleType, string calldata params, uint256 cooldownSeconds) external returns (uint256 ruleId)",
  "function pauseRule(uint256 ruleId) external",
  "function deleteRule(uint256 ruleId) external",
])

// ─── Helper — send tx + wait for receipt ─────────────────────────────────────

async function sendAndWait(
  session:       WalletSession,
  description:   string,
  txPromise:     Promise<Hash>
): Promise<Hash | null> {
  const spinner = ora(`  ${description}...`).start()

  try {
    const hash = await txPromise
    spinner.text = `  Waiting for confirmation...  (${hash.slice(0, 10)}...)`

    await session.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })

    spinner.succeed(`  ${description} confirmed`)
    return hash
  } catch (err: unknown) {
    spinner.fail(`  ${description} failed`)
    const message = err instanceof Error ? err.message : String(err)
    errorBox(message.slice(0, 200))
    return null
  }
}

// ─── DCA order creation ───────────────────────────────────────────────────────

export interface CreateTimedOrderParams {
  token:            `0x${string}`
  amountWei:        bigint
  destinationChain: bigint          // CCIP chain selector
  recipient:        `0x${string}`
  action:           string
  intervalSeconds:  bigint
  maxExecutions:    bigint
  recurring:        boolean
  deadlineUnix:     bigint          // 0 = no deadline
}

export async function createTimedOrder(
  session: WalletSession,
  params:  CreateTimedOrderParams
): Promise<Hash | null> {
  return sendAndWait(
    session,
    "Creating DCA order",
    session.walletClient.writeContract({
      address:      CONTRACTS.automatedTrader as `0x${string}`,
      abi:          TRADER_ABI,
      functionName: "createTimedOrder",
      args: [
        params.token,
        params.amountWei,
        params.destinationChain,
        params.recipient,
        params.action,
        params.intervalSeconds,
        params.maxExecutions,
        params.recurring,
        params.deadlineUnix,
      ],
      account: session.account,
      chain:   session.publicClient.chain!,
    })
  )
}

// ─── Approve LINK spend ───────────────────────────────────────────────────────

export async function approveLINK(
  session: WalletSession,
  spender: `0x${string}`,
  amount:  bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Approving LINK spend for ${spender.slice(0, 8)}...`,
    session.walletClient.writeContract({
      address:      CONTRACTS.linkToken as `0x${string}`,
      abi:          ERC20_ABI,
      functionName: "approve",
      args:         [spender, amount],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

// ─── Transfer LINK to contract ────────────────────────────────────────────────

export async function transferLINK(
  session: WalletSession,
  to:      `0x${string}`,
  amount:  bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    "Transferring LINK to contract",
    session.walletClient.writeContract({
      address:      CONTRACTS.linkToken as `0x${string}`,
      abi:          ERC20_ABI,
      functionName: "transfer",
      args:         [to, amount],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

// ─── Order management ─────────────────────────────────────────────────────────

export async function pauseOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Pausing order #${orderId}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.automatedTrader as `0x${string}`,
      abi:          TRADER_ABI,
      functionName: "pauseOrder",
      args:         [orderId],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

export async function resumeOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Resuming order #${orderId}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.automatedTrader as `0x${string}`,
      abi:          TRADER_ABI,
      functionName: "resumeOrder",
      args:         [orderId],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

export async function cancelOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Cancelling order #${orderId}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.automatedTrader as `0x${string}`,
      abi:          TRADER_ABI,
      functionName: "cancelOrder",
      args:         [orderId],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

// ─── Alert rule management ────────────────────────────────────────────────────

export async function createAlertRule(
  session:         WalletSession,
  ruleType:        string,
  params:          object,
  cooldownSeconds: number
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Creating alert rule: ${ruleType}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.chainAlertRegistry as `0x${string}`,
      abi:          ALERT_REGISTRY_ABI,
      functionName: "createRule",
      args:         [ruleType, JSON.stringify(params), BigInt(cooldownSeconds)],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

export async function pauseAlertRule(
  session: WalletSession,
  ruleId:  bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Pausing alert rule #${ruleId}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.chainAlertRegistry as `0x${string}`,
      abi:          ALERT_REGISTRY_ABI,
      functionName: "pauseRule",
      args:         [ruleId],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}

export async function deleteAlertRule(
  session: WalletSession,
  ruleId:  bigint
): Promise<Hash | null> {
  return sendAndWait(
    session,
    `Deleting alert rule #${ruleId}`,
    session.walletClient.writeContract({
      address:      CONTRACTS.chainAlertRegistry as `0x${string}`,
      abi:          ALERT_REGISTRY_ABI,
      functionName: "deleteRule",
      args:         [ruleId],
      account:      session.account,
      chain:        session.publicClient.chain!,
    })
  )
}
