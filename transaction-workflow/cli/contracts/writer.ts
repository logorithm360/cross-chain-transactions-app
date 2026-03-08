import { randomUUID } from "node:crypto"
import { type Hash } from "viem"
import ora from "ora"
import type { WalletSession } from "../wallet/connector.js"
import {
  createSession,
  createIntentForSession,
  getSessionWallet,
  subscribeIntentUpdates,
  waitForIntentTerminal,
} from "../bridge/runtime.js"
import { buildTransactions } from "../bridge/intentBuilders.js"
import type {
  IntentBuildRequest,
  PreparedIntentBundle,
  ServiceAction,
  ServiceType,
} from "../../shared/intents.js"
import { c, errorBox, infoBox, warnBox } from "../utils/display.js"

const ALERT_TYPE_MAP: Record<string, number> = {
  PORTFOLIO_DROP_PERCENT: 0,
  PORTFOLIO_DROP_ABSOLUTE: 1,
  TOKEN_CONCENTRATION: 2,
  TOKEN_FLAGGED_SUSPICIOUS: 3,
  TOKEN_PRICE_SPIKE: 4,
  TOKEN_LIQUIDITY_DROP: 5,
  TOKEN_HOLDER_CONCENTRATION: 6,
  DCA_ORDER_FAILED: 7,
  DCA_LOW_FUNDS: 8,
  DCA_ORDER_PAUSED_BY_AI: 9,
  DCA_EXECUTION_STUCK: 10,
  WALLET_LARGE_OUTFLOW: 11,
  WALLET_INTERACTION_WITH_FLAGGED: 12,
  WALLET_NEW_TOKEN_RECEIVED: 13,
}

interface IntentArgs {
  serviceType: ServiceType
  action: ServiceAction
  params: Record<string, unknown>
  description: string
}

function isSessionError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err)
  const lower = text.toLowerCase()
  return lower.includes("session not found") || lower.includes("session expired")
}

async function waitForWebSignerWallet(sessionId: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const wallet = getSessionWallet(sessionId)
    if (wallet?.account && wallet.chainId) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

async function recoverWebSignerSession(session: WalletSession): Promise<boolean> {
  const fresh = createSession()
  session.bridgeSessionId = fresh.sessionId
  session.bridgeToken = fresh.token
  session.bridgeBaseUrl = fresh.baseUrl
  session.signerUrl = fresh.signerUrlHint

  infoBox(
    "Web-signer session was refreshed automatically.\n" +
      `Open this new signer URL and reconnect MetaMask:\n${fresh.signerUrlHint}\n\n` +
      "Keep CLI running while reconnecting."
  )

  const ready = await waitForWebSignerWallet(fresh.sessionId, 3 * 60 * 1000)
  if (!ready) {
    errorBox("Timed out waiting for MetaMask reconnection on refreshed session.")
    return false
  }
  infoBox("MetaMask reconnected to refreshed session. Retrying your action.")
  return true
}

function modeLabel(intent: PreparedIntentBundle): string {
  return intent.executionMode === "CONFIDENTIAL_PRIVATE" ? "CONFIDENTIAL_PRIVATE" : "PUBLIC_EVM"
}

function printIntentProgress(intent: PreparedIntentBundle): void {
  if (intent.status === "SUBMITTED") {
    if (intent.executionMode === "CONFIDENTIAL_PRIVATE" && intent.confidentialRef) {
      console.log(
        c.dim(
          `  ↪ private submit [${modeLabel(intent)}] id=${intent.confidentialRef.privateTransferId} provider=${intent.confidentialRef.provider}`
        )
      )
      return
    }
    if (intent.submittedTxHash) {
      console.log(c.dim(`  ↪ tx submitted [${modeLabel(intent)}] hash=${intent.submittedTxHash}`))
    }
    return
  }

  if (intent.status === "CONFIRMED") {
    if (intent.executionMode === "CONFIDENTIAL_PRIVATE" && intent.confidentialRef) {
      console.log(
        c.dim(
          `  ↪ private confirmed [${modeLabel(intent)}] id=${intent.confidentialRef.privateTransferId} (no explorer tx hash path)`
        )
      )
      return
    }
    if (intent.submittedTxHash) {
      console.log(c.dim(`  ↪ confirmed [${modeLabel(intent)}] hash=${intent.submittedTxHash}`))
    }
    return
  }

  if (intent.status === "FAILED" || intent.status === "EXPIRED") {
    console.log(c.dim(`  ↪ terminal [${modeLabel(intent)}] status=${intent.status}`))
  }
}

function boolFromEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback
  const v = raw.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true
  if (v === "0" || v === "false" || v === "no" || v === "off") return false
  return fallback
}

function withConfidentialMeta(params: Record<string, unknown>): Record<string, unknown> {
  const existing = params.__confidential
  if (existing && typeof existing === "object") return params

  return {
    ...params,
    __confidential: {
      enabled: boolFromEnv(process.env.CONFIDENTIAL_COMPUTE_ENABLED_BY_DEFAULT, false),
      strict: boolFromEnv(process.env.CONFIDENTIAL_COMPUTE_STRICT, false),
      provider: "CONVERGENCE_2026_TOKEN_API",
      tokenApiBaseUrl:
        process.env.CONFIDENTIAL_TOKEN_API_BASE_URL ?? "https://convergence2026-token-api.cldev.cloud",
      hideSender: boolFromEnv(process.env.CONFIDENTIAL_HIDE_SENDER_BY_DEFAULT, true),
    },
  }
}

async function runIntent(session: WalletSession, args: IntentArgs): Promise<Hash | null> {
  const spinner = ora(`  ${args.description}...`).start()
  const paramsWithConfidential = withConfidentialMeta(args.params)

  try {
    if (session.mode === "webSigner") {
      if (!session.bridgeSessionId) throw new Error("Missing bridge session")

      let request: Omit<IntentBuildRequest, "sessionId"> = {
        nonce: randomUUID(),
        serviceType: args.serviceType,
        action: args.action,
        params: paramsWithConfidential,
      }

      let intent: PreparedIntentBundle
      try {
        intent = await createIntentForSession(session.bridgeSessionId, request)
      } catch (err) {
        if (!isSessionError(err)) throw err

        spinner.warn("  Web-signer session expired/missing. Refreshing session...")
        const recovered = await recoverWebSignerSession(session)
        if (!recovered || !session.bridgeSessionId) {
          spinner.fail(`  ${args.description} failed`)
          return null
        }
        request = { ...request, nonce: randomUUID() }
        intent = await createIntentForSession(session.bridgeSessionId, request)
      }
      spinner.text = `  Intent queued (${intent.intentId.slice(0, 8)}...)`
      infoBox(
        `Approve in MetaMask web signer.\n` +
          `Intent ID: ${intent.intentId}\n` +
          `Signer URL: ${session.signerUrl ?? "http://127.0.0.1:5173"}`
      )
      infoBox(
        `Execution mode: ${intent.executionMode}\n` +
          `Privacy outcome: ${intent.privacyOutcome}\n` +
          `Built under confidential mode: ${intent.builtWithConfidentialMode.enabled ? "ON" : "OFF"}`
      )

      let lastProgressKey = ""
      const unsubscribe = subscribeIntentUpdates(intent.intentId, (next) => {
        const key = `${next.status}:${next.submittedTxHash ?? ""}:${next.confidentialRef?.privateTransferId ?? ""}`
        if (key === lastProgressKey) return
        lastProgressKey = key
        printIntentProgress(next)
      })

      try {
        const final = await waitForIntentTerminal(intent.intentId, 20 * 60 * 1000)
        if (final.status === "CONFIRMED") {
          spinner.succeed(`  ${args.description} confirmed`)
          if (final.executionMode === "CONFIDENTIAL_PRIVATE" && final.confidentialRef) {
            infoBox(
              `Confidential submission confirmed via ${final.confidentialRef.provider}.\n` +
                `Private transfer ID: ${final.confidentialRef.privateTransferId}\n` +
                "No public explorer tx hash was used for submission."
            )
            return null
          }
          if (final.submittedTxHash) {
            return final.submittedTxHash
          }
          warnBox("Intent confirmed, but no transaction hash was recorded.")
          return null
        }
        spinner.fail(`  ${args.description} failed`)
        errorBox(final.error ?? `Intent ended with status ${final.status}`)
        return null
      } finally {
        unsubscribe()
      }
    }

    // private key path: execute prepared txs directly.
    const txs = await buildTransactions({
      sessionId: "local-direct",
      nonce: randomUUID(),
      serviceType: args.serviceType,
      action: args.action,
      params: paramsWithConfidential,
    })

    let lastHash: Hash | null = null
    for (const prepared of txs) {
      if (prepared.chainId !== session.chainId) {
        throw new Error(
          `Private-key mode is connected to chainId ${session.chainId}, but this action requires chainId ${prepared.chainId}. Reconnect on the required source network.`
        )
      }
      spinner.text = `  Sending ${prepared.description}...`
      const hash = await session.walletClient.sendTransaction({
        account: session.account,
        chain: session.publicClient.chain!,
        to: prepared.to,
        data: prepared.data,
        value: BigInt(prepared.value),
      })
      spinner.text = `  Waiting confirmation (${hash.slice(0, 10)}...)`
      await session.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
      lastHash = hash
    }

    spinner.succeed(`  ${args.description} confirmed`)
    return lastHash
  } catch (err) {
    spinner.fail(`  ${args.description} failed`)
    const message = err instanceof Error ? err.message : String(err)
    errorBox(message.slice(0, 300))
    return null
  }
}

export interface CreateTimedOrderParams {
  sourceChainId?: number
  token: `0x${string}`
  amountWei: bigint
  destinationChain?: bigint
  destinationChainKey?: string
  destinationChainId?: number
  recipient: `0x${string}`
  action: string
  intervalSeconds: bigint
  maxExecutions: bigint
  recurring: boolean
  deadlineUnix: bigint
}

export async function createTimedOrder(
  session: WalletSession,
  params: CreateTimedOrderParams
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "DCA",
    action: "DCA_CREATE_TIMED_ORDER",
    description: "Creating DCA order",
    params: {
      sourceChainId: params.sourceChainId ?? session.chainId,
      token: params.token,
      amountWei: params.amountWei.toString(),
      destinationChainKey: params.destinationChainKey,
      destinationChainId: params.destinationChainId,
      recipient: params.recipient,
      action: params.action,
      intervalSeconds: Number(params.intervalSeconds),
      maxExecutions: Number(params.maxExecutions),
      recurring: params.recurring,
      deadlineUnix: Number(params.deadlineUnix),
    },
  })
}

export async function approveLINK(
  _session: WalletSession,
  _spender: `0x${string}`,
  _amount: bigint
): Promise<Hash | null> {
  // Approval is bundled automatically in transfer/vault actions when needed.
  return null
}

export async function transferLINK(
  session: WalletSession,
  to: `0x${string}`,
  amount: bigint
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "DCA",
    action: "DCA_FUND_LINK",
    description: "Funding DCA contract with LINK",
    params: {
      sourceChainId: session.chainId,
      amountWei: amount.toString(),
      to,
    },
  })
}

export async function pauseOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "DCA",
    action: "DCA_SET_ORDER_PAUSED",
    description: `Pausing order #${orderId}`,
    params: {
      sourceChainId: session.chainId,
      orderId: Number(orderId),
      paused: true,
    },
  })
}

export async function resumeOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "DCA",
    action: "DCA_SET_ORDER_PAUSED",
    description: `Resuming order #${orderId}`,
    params: {
      sourceChainId: session.chainId,
      orderId: Number(orderId),
      paused: false,
    },
  })
}

export async function cancelOrder(
  session: WalletSession,
  orderId: bigint
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "DCA",
    action: "DCA_CANCEL_ORDER",
    description: `Cancelling order #${orderId}`,
    params: {
      sourceChainId: session.chainId,
      orderId: Number(orderId),
    },
  })
}

export async function createAlertRule(
  session: WalletSession,
  ruleType: string,
  params: object,
  cooldownSeconds: number
): Promise<Hash | null> {
  const alertType = ALERT_TYPE_MAP[ruleType]
  if (alertType === undefined) {
    errorBox(`Unsupported alert type: ${ruleType}`)
    return null
  }

  return runIntent(session, {
    serviceType: "CHAINALERT",
    action: "CHAINALERT_UPSERT_RULE",
    description: `Creating alert rule: ${ruleType}`,
    params: {
      sourceChainId: session.chainId,
      ruleId: 0,
      alertType,
      enabled: true,
      cooldownSeconds,
      rearmSeconds: 0,
      paramsObject: params,
    },
  })
}

export async function pauseAlertRule(
  session: WalletSession,
  ruleId: bigint
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "CHAINALERT",
    action: "CHAINALERT_SET_RULE_ENABLED",
    description: `Disabling alert rule #${ruleId}`,
    params: {
      sourceChainId: session.chainId,
      ruleId: Number(ruleId),
      enabled: false,
    },
  })
}

export async function deleteAlertRule(
  session: WalletSession,
  ruleId: bigint
): Promise<Hash | null> {
  // Registry has no delete; disable is the canonical equivalent in v1.
  return pauseAlertRule(session, ruleId)
}

export interface ChainShieldTransferParams {
  sourceChainId?: number
  token: `0x${string}`
  amountWei: bigint
  destinationChainKey: string
  recipient: `0x${string}`
}

export async function createChainShieldTransfer(
  session: WalletSession,
  params: ChainShieldTransferParams
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "CHAINSHIELD",
    action: "CHAINSHIELD_TRANSFER",
    description: "Submitting ChainShield transfer",
    params: {
      sourceChainId: params.sourceChainId ?? session.chainId,
      token: params.token,
      amountWei: params.amountWei.toString(),
      destinationChainKey: params.destinationChainKey,
      recipient: params.recipient,
    },
  })
}

export interface CrossVaultDepositParams {
  sourceChainId?: number
  token: `0x${string}`
  amountWei: bigint
  destinationChainKey: string
  recipient: `0x${string}`
  action?: string
  extraDataHex?: `0x${string}`
  deadlineUnix?: bigint
}

export async function createCrossVaultDeposit(
  session: WalletSession,
  params: CrossVaultDepositParams
): Promise<Hash | null> {
  return runIntent(session, {
    serviceType: "CROSSVAULT",
    action: "CROSSVAULT_DEPOSIT",
    description: "Submitting CrossVault deposit",
    params: {
      sourceChainId: params.sourceChainId ?? session.chainId,
      token: params.token,
      amountWei: params.amountWei.toString(),
      destinationChainKey: params.destinationChainKey,
      recipient: params.recipient,
      action: params.action ?? "deposit",
      extraDataHex: params.extraDataHex ?? "0x",
      deadlineUnix: Number(params.deadlineUnix ?? 0n),
    },
  })
}
