// cli/screens/alerts.ts
// ChainAlert Intelligence — full interactive flow.
//
// Sub-menus:
//   [1] Create alert rule
//   [2] View active alert rules
//   [3] View alert history
//   [4] Pause / delete a rule
//   [B] Back

import ora from "ora"
import {
  printBanner, printHeader, printWalletBar,
  printTable, badge, successBox, errorBox,
  warnBox, infoBox, hr, c, shortAddr,
} from "../utils/display.js"
import {
  askSelect, askText, askNumber, askAddress,
  confirm, pressEnter,
} from "../utils/input.js"
import type { WalletSession }    from "../wallet/connector.js"
import { requireSigning }        from "../wallet/connector.js"
import {
  getUserAlertRules, getAlertHistory,
  type AlertRule,
} from "../contracts/reader.js"
import {
  createAlertRule, pauseAlertRule, deleteAlertRule,
} from "../contracts/writer.js"

// ─── Cooldown options ─────────────────────────────────────────────────────────

const COOLDOWN_OPTIONS = [
  { title: "1 hour",   value: 3600   },
  { title: "4 hours",  value: 14400  },
  { title: "24 hours", value: 86400  },
  { title: "7 days",   value: 604800 },
]

// ─── Main alerts screen loop ──────────────────────────────────────────────────

export async function alertsScreen(session: WalletSession): Promise<void> {
  while (true) {
    printBanner()
    printWalletBar(session.address, session.chainName, session.balanceEth)
    printHeader("④ ChainAlert Intelligence — AI-Powered Monitoring")

    const choice = await askSelect("What would you like to do?", [
      { title: "Create alert rule",      value: "create",  description: "Set up a new monitoring rule" },
      { title: "View active rules",      value: "view",    description: "See all your alert rules and their status" },
      { title: "View alert history",     value: "history", description: "See what alerts have fired" },
      { title: "Enable / disable a rule", value: "manage", description: "Toggle monitoring state for a rule" },
      { title: "← Back to main menu",   value: "back",    description: "" },
    ])

    if (!choice || choice === "back") return

    switch (choice) {
      case "create":  await createRuleFlow(session);  break
      case "view":    await viewRulesFlow(session);   break
      case "history": await historyFlow(session);     break
      case "manage":  await manageRuleFlow(session);  break
    }
  }
}

// ─── Create rule flow ─────────────────────────────────────────────────────────

async function createRuleFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Create Alert Rule")

  const category = await askSelect("What do you want to monitor?", [
    { title: "Portfolio drop %",           value: "PORTFOLIO_DROP_PERCENT",     description: "Alert when your portfolio loses value" },
    { title: "Token flagged suspicious",   value: "TOKEN_FLAGGED_SUSPICIOUS",   description: "Alert if any held token gets blacklisted" },
    { title: "DCA order failed",           value: "DCA_ORDER_FAILED",           description: "Alert immediately when a DCA execution fails" },
    { title: "DCA transfer stuck",         value: "DCA_EXECUTION_STUCK",        description: "Alert if a CCIP transfer is unconfirmed too long" },
    { title: "Large wallet outflow",       value: "WALLET_LARGE_OUTFLOW",       description: "Alert on big unexpected outflows" },
    { title: "Token price spike",          value: "TOKEN_PRICE_SPIKE",          description: "Alert when a token moves sharply" },
    { title: "DCA low funds warning",      value: "DCA_LOW_FUNDS",              description: "Alert when LINK balance is running low" },
    { title: "New token received",         value: "WALLET_NEW_TOKEN_RECEIVED",  description: "Alert when an unknown token lands in wallet" },
  ])
  if (!category) return

  // Collect rule-specific parameters
  const params = await collectRuleParams(category, session)
  if (!params) return

  // Cooldown
  const cooldownChoice = await askSelect("How often can this alert re-fire?", [
    ...COOLDOWN_OPTIONS.map(o => ({ title: o.title, value: String(o.value) })),
    { title: "Custom (enter seconds)",  value: "custom" },
  ])
  if (!cooldownChoice) return

  let cooldownSeconds: number
  if (cooldownChoice === "custom") {
    const secs = await askNumber("Cooldown in seconds", { min: 60 })
    if (secs === null) return
    cooldownSeconds = secs
  } else {
    cooldownSeconds = parseInt(cooldownChoice)
  }

  // Summary
  hr()
  console.log(c.bold("  Alert Rule Summary"))
  console.log()
  console.log(`  Type:     ${c.bold(category)}`)
  console.log(`  Params:   ${c.dim(JSON.stringify(params, null, 0))}`)
  console.log(`  Cooldown: ${c.value(String(cooldownSeconds / 3600))}h between re-fires`)
  console.log()

  const ok = await confirm("Create this alert rule?")
  if (!ok) return

  const hash = await createAlertRule(session, category, params, cooldownSeconds)
  if (hash) {
    successBox(`Alert rule created! Tx: ${hash}`)
    infoBox("ChainAlert Intelligence will start monitoring on the next workflow cycle.")
  }

  await pressEnter()
}

// ─── Parameter collection per rule type ──────────────────────────────────────

async function collectRuleParams(
  ruleType: string,
  session:  WalletSession
): Promise<object | null> {
  switch (ruleType) {

    case "PORTFOLIO_DROP_PERCENT": {
      const threshold = await askNumber(
        "Alert when portfolio drops by what % from baseline?",
        { min: 1, max: 99, initial: 15 }
      )
      if (threshold === null) return null

      const baseline = await askSelect("What is the baseline (100%)?", [
        { title: "24-hour high",  value: "24h_high" },
        { title: "7-day high",    value: "7d_high"  },
        { title: "Entry price",   value: "entry"    },
      ])
      if (!baseline) return null

      return { threshold_pct: threshold, baseline }
    }

    case "TOKEN_FLAGGED_SUSPICIOUS": {
      infoBox("We will monitor all tokens held in your wallet automatically.")
      const checkInterval = await askSelect("How often to check?", [
        { title: "Every hour",  value: "3600"  },
        { title: "Every 15min", value: "900"   },
        { title: "Every 6h",    value: "21600" },
      ])
      if (!checkInterval) return null
      return { check_interval_seconds: Number(checkInterval), auto_detect_tokens: true }
    }

    case "DCA_ORDER_FAILED": {
      const orderIdStr = await askText(
        "Monitor which order IDs? (comma-separated, or * for all)",
        { initial: "*" }
      )
      if (!orderIdStr) return null
      return { order_ids: orderIdStr === "*" ? ["*"] : orderIdStr.split(",").map(s => s.trim()) }
    }

    case "DCA_EXECUTION_STUCK": {
      const hours = await askNumber(
        "Alert if a transfer is unconfirmed for how many hours?",
        { min: 1, max: 48, initial: 2 }
      )
      if (hours === null) return null
      return { threshold_hours: hours }
    }

    case "WALLET_LARGE_OUTFLOW": {
      const thresholdUsd = await askNumber(
        "Alert when outflow exceeds $USD in 1 hour",
        { min: 100, initial: 10000 }
      )
      if (thresholdUsd === null) return null
      return { threshold_usd: thresholdUsd, window_minutes: 60, wallets: [session.address] }
    }

    case "TOKEN_PRICE_SPIKE": {
      const pct = await askNumber(
        "Alert when any held token moves by what % in 1 hour?",
        { min: 1, max: 200, initial: 20 }
      )
      if (pct === null) return null
      return { threshold_pct: pct, window_minutes: 60, auto_detect_tokens: true }
    }

    case "DCA_LOW_FUNDS": {
      const remaining = await askNumber(
        "Alert when executions remaining drops below:",
        { min: 1, max: 50, initial: 3 }
      )
      if (remaining === null) return null
      return { threshold_executions: remaining, order_ids: ["*"] }
    }

    case "WALLET_NEW_TOKEN_RECEIVED": {
      const minValueUsd = await askNumber(
        "Minimum token value ($USD) to trigger alert (filters dust attacks)",
        { min: 0, initial: 10 }
      )
      if (minValueUsd === null) return null
      return { min_value_usd: minValueUsd, wallets: [session.address], verify_token: true }
    }

    default:
      return {}
  }
}

// ─── View rules flow ──────────────────────────────────────────────────────────

async function viewRulesFlow(session: WalletSession): Promise<void> {
  printHeader("Active Alert Rules")

  const spinner = ora("  Loading alert rules...").start()
  let rules: AlertRule[]

  try {
    rules = await getUserAlertRules(session)
    spinner.succeed(`  Found ${rules.length} rule(s)`)
  } catch (err) {
    spinner.fail("  Could not load rules")
    errorBox(String(err))
    await pressEnter()
    return
  }

  if (rules.length === 0) {
    infoBox("You have no alert rules. Create one to start monitoring.")
    await pressEnter()
    return
  }

  printTable(
    ["ID", "Type", "Status", "Fired", "Last triggered"],
    rules.map(r => [
      String(r.ruleId),
      r.ruleType.replace(/_/g, " "),
      badge(r.status),
      String(r.triggerCount),
      r.lastTriggeredAt === 0n
        ? c.dim("never")
        : new Date(Number(r.lastTriggeredAt) * 1000).toLocaleString(),
    ])
  )

  await pressEnter()
}

// ─── History flow ─────────────────────────────────────────────────────────────

async function historyFlow(session: WalletSession): Promise<void> {
  printHeader("Alert History")

  const spinner = ora("  Loading alert history...").start()

  try {
    const history = await getAlertHistory(session, 10) as any[]
    spinner.succeed(`  Found ${history.length} recent alert(s)`)

    if (history.length === 0) {
      infoBox("No direct history endpoint is configured. Use 'View active rules' for live state.")
      await pressEnter()
      return
    }

    for (const alert of history) {
      hr()
      const severityColour =
        alert.severity === 2 ? c.error :
        alert.severity === 1 ? c.warn  : c.dim

      console.log(severityColour(`  [${["INFO","WARNING","CRITICAL"][alert.severity] ?? "?"}]  ${alert.headline}`))
      console.log(c.dim(`  Rule: ${alert.ruleType.replace(/_/g, " ")}  •  ${new Date(Number(alert.triggeredAt) * 1000).toLocaleString()}`))
      if (alert.explanation) {
        console.log()
        console.log(`  ${alert.explanation}`)
      }
    }
    console.log()
  } catch (err) {
    spinner.fail("  Could not load history")
    errorBox(String(err))
  }

  await pressEnter()
}

// ─── Manage rule flow ─────────────────────────────────────────────────────────

async function manageRuleFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Toggle Alert Rule")

  const ruleIdStr = await askText("Enter rule ID to manage")
  if (!ruleIdStr) return

  const ruleId = BigInt(ruleIdStr)

  const action = await askSelect("What would you like to do?", [
    { title: "Disable rule", value: "pause"  },
    { title: "Disable rule (legacy delete action)", value: "delete" },
  ])
  if (!action) return
  warnBox("ChainAlertRegistry v1 supports enable/disable only; delete maps to disable.")

  const ok = await confirm(`Disable rule #${ruleId}?`, false)
  if (!ok) return

  const hash = action === "pause"
    ? await pauseAlertRule(session, ruleId)
    : await deleteAlertRule(session, ruleId)

  if (hash) successBox(`Rule disabled. Tx: ${hash}`)
  await pressEnter()
}
