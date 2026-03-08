// cli/screens/dca.ts
// AutoPilot DCA — full interactive flow.
//
// Sub-menus:
//   [1] Create new DCA order
//   [2] View my orders
//   [3] Manage order (pause / resume / cancel)
//   [4] Fund contract (deposit LINK)
//   [B] Back

import ora from "ora"
import {
  printBanner, printHeader, printWalletBar,
  printTable, printCCIPLink, badge, successBox,
  errorBox, warnBox, infoBox, hr, c, shortAddr, formatUnits,
} from "../utils/display.js"
import {
  askSelect, askText, askNumber, askAddress,
  askAmount, confirm, pressEnter,
} from "../utils/input.js"
import type { WalletSession }    from "../wallet/connector.js"
import { requireSigning }        from "../wallet/connector.js"
import {
  getUserOrders, getLinkBalance,
  DCA_STATUS_LABELS, type OrderSnapshot,
} from "../contracts/reader.js"
import {
  createTimedOrder, pauseOrder, resumeOrder,
  cancelOrder, transferLINK, approveLINK,
} from "../contracts/writer.js"
import { CONTRACTS, DESTINATION_CHAIN_OPTIONS, buildCCIPLink } from "../config.js"
import { parseEther, parseUnits } from "viem"

// ─── Chain selector mapping ───────────────────────────────────────────────────

const CHAIN_SELECTORS: Record<string, bigint> = {
  amoy:            16281711391670634445n,
  arbitrumSepolia: 3478487238524512106n,
  baseSepolia:     10344971235874465080n,
  fuji:            14767482510784806043n,
}

// ─── Main DCA screen loop ─────────────────────────────────────────────────────

export async function dcaScreen(session: WalletSession): Promise<void> {
  while (true) {
    printBanner()
    printWalletBar(session.address, session.chainName, session.balanceEth)
    printHeader("① AutoPilot DCA — AI-Gated Recurring Investments")

    const choice = await askSelect("What would you like to do?", [
      { title: "Create new DCA order",          value: "create",  description: "Set up a recurring cross-chain investment" },
      { title: "View my orders",                value: "view",    description: "See all your DCA orders and their status" },
      { title: "Manage order",                  value: "manage",  description: "Pause, resume, or cancel an order" },
      { title: "Fund contract  (deposit LINK)", value: "fund",    description: "Top up LINK so your orders keep running" },
      { title: "← Back to main menu",           value: "back",    description: "" },
    ])

    if (!choice || choice === "back") return

    switch (choice) {
      case "create": await createOrderFlow(session);  break
      case "view":   await viewOrdersFlow(session);   break
      case "manage": await manageOrderFlow(session);  break
      case "fund":   await fundContractFlow(session); break
    }
  }
}

// ─── Create order flow ────────────────────────────────────────────────────────

async function createOrderFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Create DCA Order")

  // Step 1 — Token to DCA
  const tokenAddr = await askAddress("Token contract address to DCA (on Sepolia)")
  if (!tokenAddr) return

  // Step 2 — Amount per execution
  const amountStr = await askAmount("Amount per execution", "tokens")
  if (!amountStr) return

  // Step 3 — Destination chain
  const destChainKey = await askSelect("Destination chain", DESTINATION_CHAIN_OPTIONS as any)
  if (!destChainKey) return
  const destSelector = CHAIN_SELECTORS[destChainKey]!

  // Step 4 — Recipient on destination
  const recipient = await askAddress("Recipient address on destination chain")
  if (!recipient) return

  // Step 5 — Action string
  const action = await askSelect("What should happen with the tokens on arrival?", [
    { title: "Transfer  — just send them",      value: "transfer" },
    { title: "Stake     — stake on arrival",    value: "stake"    },
    { title: "Swap      — swap to native gas",  value: "swap"     },
    { title: "Deposit   — deposit to a vault",  value: "deposit"  },
  ])
  if (!action) return

  // Step 6 — Interval
  const intervalChoice = await askSelect("How often should this execute?", [
    { title: "Every day  (24h)",   value: "86400"  },
    { title: "Every week (7 days)", value: "604800" },
    { title: "Every hour",          value: "3600"   },
    { title: "Custom (enter hours)", value: "custom" },
  ])
  if (!intervalChoice) return

  let intervalSeconds = BigInt(intervalChoice)
  if (intervalChoice === "custom") {
    const hours = await askNumber("Interval in hours", { min: 1, max: 8760 })
    if (hours === null) return
    intervalSeconds = BigInt(hours * 3600)
  }

  // Step 7 — Max executions
  const maxExecStr = await askNumber("Max executions (0 = unlimited)", { min: 0 })
  if (maxExecStr === null) return
  const maxExecutions = BigInt(maxExecStr)

  // Step 8 — AI gate
  const aiGate = await confirm("Enable AI gate? (Gemini evaluates market conditions before each execution)")

  // Step 9 — Confirmation summary
  hr()
  console.log(c.bold("  Order Summary"))
  console.log()
  console.log(`  Token:        ${c.addr(shortAddr(tokenAddr))}`)
  console.log(`  Amount:       ${c.value(amountStr)} tokens per execution`)
  console.log(`  Destination:  ${c.bold(DESTINATION_CHAIN_OPTIONS.find(d => d.value === destChainKey)?.title ?? destChainKey)}`)
  console.log(`  Recipient:    ${c.addr(shortAddr(recipient))}`)
  console.log(`  Action:       ${c.bold(action)}`)
  console.log(`  Interval:     ${c.value(String(Number(intervalSeconds) / 3600) + "h")}`)
  console.log(`  Max runs:     ${c.value(maxExecutions === 0n ? "unlimited" : String(maxExecutions))}`)
  console.log(`  AI gate:      ${aiGate ? c.success("enabled") : c.dim("disabled")}`)
  console.log()

  const ok = await confirm("Submit this order on-chain?")
  if (!ok) { infoBox("Order cancelled."); await pressEnter(); return }

  // Parse amount to wei (assumes 18 decimals — adjust for USDC etc)
  const amountWei = parseEther(amountStr)

  const hash = await createTimedOrder(session, {
    token:            tokenAddr,
    amountWei,
    destinationChain: destSelector,
    recipient,
    action,
    intervalSeconds,
    maxExecutions,
    recurring:        true,
    deadlineUnix:     0n,
  })

  if (hash) {
    successBox(`Order created! Tx: ${hash}`)
    infoBox("Your DCA order is now active. The AutoPilot workflow will execute it automatically.")
    if (aiGate) {
      infoBox("AI gate is enabled — Gemini will evaluate market conditions before each execution cycle.")
    }
  }

  await pressEnter()
}

// ─── View orders flow ─────────────────────────────────────────────────────────

async function viewOrdersFlow(session: WalletSession): Promise<void> {
  printHeader("My DCA Orders")

  const spinner = ora("  Loading orders from Sepolia...").start()
  let orders: OrderSnapshot[]

  try {
    orders = await getUserOrders(session)
    spinner.succeed(`  Found ${orders.length} order(s)`)
  } catch (err) {
    spinner.fail("  Failed to load orders")
    errorBox(String(err))
    await pressEnter()
    return
  }

  if (orders.length === 0) {
    infoBox("You have no DCA orders. Create one from the DCA menu.")
    await pressEnter()
    return
  }

  // Render order table
  printTable(
    ["ID", "Status", "Amount", "Dest", "Executions", "Next Run", "Funded"],
    orders.map(o => [
      String(o.orderId),
      badge(DCA_STATUS_LABELS[o.dcaStatus] ?? String(o.dcaStatus)),
      formatUnits(o.amount) + " tokens",
      String(o.destinationChain).slice(0, 8) + "...",
      `${o.executionCount} / ${o.maxExecutions === 0n ? "∞" : o.maxExecutions}`,
      o.nextExecutionAt === 0n
        ? "now"
        : new Date(Number(o.nextExecutionAt) * 1000).toLocaleString(),
      o.isFunded ? c.success("yes") : c.error("no"),
    ])
  )

  // Let user drill into a specific order
  const viewDetail = await confirm("View details for a specific order?")
  if (!viewDetail) return

  const orderIdStr = await askText("Enter order ID")
  if (!orderIdStr) return

  const order = orders.find(o => o.orderId === BigInt(orderIdStr))
  if (!order) { errorBox("Order not found."); await pressEnter(); return }

  printOrderDetail(order)
  await pressEnter()
}

function printOrderDetail(order: OrderSnapshot): void {
  const ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000"

  hr()
  console.log(c.bold(`  Order #${order.orderId} — Detail`))
  console.log()
  console.log(`  Status:     ${badge(DCA_STATUS_LABELS[order.dcaStatus] ?? String(order.dcaStatus))}`)
  console.log(`  Token:      ${c.addr(shortAddr(order.token))}`)
  console.log(`  Amount:     ${c.value(formatUnits(order.amount))} tokens`)
  console.log(`  Action:     ${c.bold(order.action)}`)
  console.log(`  Interval:   ${c.value(String(Number(order.interval) / 3600))}h`)
  console.log(`  Executions: ${c.value(String(order.executionCount))} / ${order.maxExecutions === 0n ? "∞" : order.maxExecutions}`)
  console.log(`  LINK bal:   ${c.value(formatUnits(order.contractLinkBalance))} LINK`)
  console.log(`  Funded for: ${c.value(String(order.executionsRemainingFunded))} more runs`)
  console.log()

  // CCIP history buckets
  const completed = order.lastCompletedMessageIds.filter(id => id !== ZERO)
  const pending   = order.lastPendingMessageIds.filter(id => id !== ZERO)
  const failed    = order.lastFailedMessageIds.filter(id => id !== ZERO)

  if (completed.length > 0) {
    console.log(c.success("  ✓ Completed transfers:"))
    completed.forEach((id, i) => printCCIPLink(`    ${i + 1}`, id))
  }
  if (pending.length > 0) {
    console.log(c.dim("  ⏳ In-flight transfers:"))
    pending.forEach((id, i) => printCCIPLink(`    ${i + 1}`, id))
  }
  if (failed.length > 0) {
    console.log(c.error("  ✗ Failed transfers:"))
    failed.forEach((id, i) => printCCIPLink(`    ${i + 1}`, id))
  }
  console.log()
}

// ─── Manage order flow ────────────────────────────────────────────────────────

async function manageOrderFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Manage Order")

  const orderIdStr = await askText("Enter the order ID to manage")
  if (!orderIdStr) return

  const orderId = BigInt(orderIdStr)

  const action = await askSelect("What would you like to do?", [
    { title: "Pause order",   value: "pause"  },
    { title: "Resume order",  value: "resume" },
    { title: "Cancel order",  value: "cancel" },
  ])
  if (!action) return

  const ok = await confirm(`Are you sure you want to ${action} order #${orderId}?`, false)
  if (!ok) return

  let hash: string | null = null

  switch (action) {
    case "pause":  hash = await pauseOrder(session, orderId);  break
    case "resume": hash = await resumeOrder(session, orderId); break
    case "cancel": hash = await cancelOrder(session, orderId); break
  }

  if (hash) successBox(`Order ${action}d. Tx: ${hash}`)
  await pressEnter()
}

// ─── Fund contract flow ───────────────────────────────────────────────────────

async function fundContractFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Fund DCA Contract — Deposit LINK")

  const spinner = ora("  Checking LINK balance...").start()
  let linkBalance: bigint

  try {
    linkBalance = await getLinkBalance(session)
    spinner.succeed(`  Your LINK balance: ${formatUnits(linkBalance)} LINK`)
  } catch {
    spinner.fail("  Could not read LINK balance")
    await pressEnter()
    return
  }

  const contractLink = await getLinkBalance(
    session,
    CONTRACTS.automatedTrader as `0x${string}`
  )
  infoBox(`Contract LINK balance: ${formatUnits(contractLink)} LINK`)

  const amountStr = await askAmount("How much LINK to deposit?", "LINK")
  if (!amountStr) return

  const amountWei = parseEther(amountStr)
  if (amountWei > linkBalance) {
    errorBox(`You only have ${formatUnits(linkBalance)} LINK. Cannot deposit ${amountStr}.`)
    await pressEnter()
    return
  }

  const ok = await confirm(`Deposit ${amountStr} LINK to the DCA contract?`)
  if (!ok) return

  // Transfer LINK directly to contract
  const hash = await transferLINK(
    session,
    CONTRACTS.automatedTrader as `0x${string}`,
    amountWei
  )

  if (hash) {
    successBox(`LINK deposited. Tx: ${hash}`)
    infoBox("Your DCA orders will now use this LINK for CCIP fees.")
  }

  await pressEnter()
}
