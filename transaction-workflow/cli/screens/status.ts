// cli/screens/status.ts
// Aggregated status dashboard across all four services.

import ora from "ora"
import {
  printBanner,
  printHeader,
  printWalletBar,
  printTable,
  badge,
  infoBox,
  c,
} from "../utils/display.js"
import type { WalletSession } from "../wallet/connector.js"
import {
  getUserOrders,
  getUserAlertRules,
  DCA_STATUS_LABELS,
  type OrderSnapshot,
  type AlertRule,
} from "../contracts/reader.js"
import { pressEnter } from "../utils/input.js"

function countActiveOrders(orders: OrderSnapshot[]): number {
  // 1=Scheduled and 2=Awaiting condition are considered active runtime states.
  return orders.filter((o) => o.dcaStatus === 1 || o.dcaStatus === 2).length
}

function countPausedOrders(orders: OrderSnapshot[]): number {
  // 3=Paused by owner and 4=Paused by AI.
  return orders.filter((o) => o.dcaStatus === 3 || o.dcaStatus === 4).length
}

function countActiveRules(rules: AlertRule[]): number {
  return rules.filter((r) => r.isActive).length
}

export async function statusScreen(session: WalletSession): Promise<void> {
  printBanner()
  printWalletBar(session.address, session.chainName, session.balanceEth)
  printHeader("⑤ Service Status Dashboard")

  const spinner = ora("  Loading DCA and ChainAlert status...").start()

  let orders: OrderSnapshot[] = []
  let rules: AlertRule[] = []
  let dcaError: string | null = null
  let alertError: string | null = null

  try {
    orders = await getUserOrders(session)
  } catch (err) {
    dcaError = err instanceof Error ? err.message : String(err)
  }

  try {
    rules = await getUserAlertRules(session)
  } catch (err) {
    alertError = err instanceof Error ? err.message : String(err)
  }

  spinner.stop()

  printTable(
    ["Service", "Runtime", "Summary", "Notes"],
    [
      [
        "AutoPilot DCA",
        dcaError ? badge("FAILED") : badge("ACTIVE"),
        dcaError
          ? c.error("read failed")
          : `${orders.length} order(s) · ${countActiveOrders(orders)} active · ${countPausedOrders(orders)} paused`,
        dcaError ? dcaError.slice(0, 80) : "On-chain reads connected",
      ],
      [
        "ChainAlert Intelligence",
        alertError ? badge("FAILED") : badge("ACTIVE"),
        alertError
          ? c.error("read failed")
          : `${rules.length} rule(s) · ${countActiveRules(rules)} enabled`,
        alertError ? alertError.slice(0, 80) : "On-chain reads connected",
      ],
      [
        "ChainShield Transfer",
        badge("PENDING"),
        "Stub/integration mode",
        "Tracking and AI-verification placeholders enabled",
      ],
      [
        "CrossVault",
        badge("PENDING"),
        "Stub/integration mode",
        "Vault options and positions currently simulated",
      ],
    ]
  )

  if (!dcaError && orders.length > 0) {
    const latest = orders[0]
    infoBox(
      `Sample DCA order #${latest.orderId}: ` +
      `${DCA_STATUS_LABELS[latest.dcaStatus] ?? "Unknown"}`
    )
  }

  if (!alertError && rules.length > 0) {
    const latest = rules[0]
    infoBox(`Sample alert rule #${latest.ruleId}: ${latest.ruleType}`)
  }

  await pressEnter()
}
