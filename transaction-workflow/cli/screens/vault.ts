// cli/screens/vault.ts
// CrossVault — cross-chain yield. Deposit once, earn everywhere.
//
// Sub-menus:
//   [1] Deposit to vault
//   [2] View my positions
//   [3] Withdraw
//   [B] Back

import {
  printBanner, printHeader, printWalletBar,
  printTable, badge, successBox, errorBox,
  infoBox, hr, c, shortAddr,
} from "../utils/display.js"
import {
  askSelect, askAmount, askAddress,
  confirm, pressEnter,
} from "../utils/input.js"
import { askSourceChainAndToken } from "../utils/tokenSelection.js"
import type { WalletSession }  from "../wallet/connector.js"
import { requireSigning }      from "../wallet/connector.js"
import { DESTINATION_CHAIN_OPTIONS, type ChainKey } from "../config.js"
import { parseUnits } from "viem"
import { createCrossVaultDeposit } from "../contracts/writer.js"

interface VaultRouteOption {
  title: string
  value: string
  description?: string
  destinationChainKey?: ChainKey
  action?: string
}

function defaultVaultRoutes(): VaultRouteOption[] {
  return DESTINATION_CHAIN_OPTIONS.map((chain) => ({
    title: `Standard Vault Route — ${chain.title}`,
    value: `route:${chain.value}`,
    description: "Bridge and deposit into the default vault receiver route",
    destinationChainKey: chain.value,
    action: "deposit",
  }))
}

function loadVaultRoutes(): VaultRouteOption[] {
  const raw = process.env.CROSSVAULT_VAULT_OPTIONS_JSON
  if (!raw) return defaultVaultRoutes()

  try {
    const parsed = JSON.parse(raw) as unknown[]
    const out: VaultRouteOption[] = []

    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue
      const row = entry as Record<string, unknown>
      if (typeof row.title !== "string" || typeof row.value !== "string") continue

      const destinationChainKey =
        typeof row.destinationChainKey === "string" && row.destinationChainKey in Object.fromEntries(
          DESTINATION_CHAIN_OPTIONS.map((c) => [c.value, true])
        )
          ? (row.destinationChainKey as ChainKey)
          : undefined

      out.push({
        title: row.title,
        value: row.value,
        description: typeof row.description === "string" ? row.description : undefined,
        destinationChainKey,
        action: typeof row.action === "string" ? row.action : "deposit",
      })
    }

    return out.length > 0 ? out : defaultVaultRoutes()
  } catch {
    return defaultVaultRoutes()
  }
}

const VAULT_OPTIONS = loadVaultRoutes()

// ─── Main vault screen loop ───────────────────────────────────────────────────

export async function vaultScreen(session: WalletSession): Promise<void> {
  while (true) {
    printBanner()
    printWalletBar(session.address, session.chainName, session.balanceEth)
    printHeader("③ CrossVault — Cross-Chain Yield Strategies")

    const choice = await askSelect("What would you like to do?", [
      { title: "Deposit to vault",      value: "deposit",  description: "Move tokens cross-chain into a yield strategy" },
      { title: "View my positions",     value: "view",     description: "See all active vault positions and accrued yield" },
      { title: "Withdraw",              value: "withdraw", description: "Pull tokens back from a vault position" },
      { title: "← Back to main menu",  value: "back",     description: "" },
    ])

    if (!choice || choice === "back") return

    switch (choice) {
      case "deposit":  await depositFlow(session);  break
      case "view":     await viewPositionsFlow();   break
      case "withdraw": await withdrawFlow(session); break
    }
  }
}

// ─── Deposit flow ─────────────────────────────────────────────────────────────

async function depositFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Deposit to Vault")

  // Select vault route (dynamic via env config or derived defaults)
  const vaultChoice = await askSelect(
    "Select a vault route",
    VAULT_OPTIONS.map((v) => ({
      title: v.title,
      value: v.value,
      description: v.description ?? "",
    }))
  )
  if (!vaultChoice) return
  const selected = VAULT_OPTIONS.find((v) => v.value === vaultChoice)
  if (!selected) return

  // Source network + token
  const source = await askSourceChainAndToken("CROSSVAULT_DEPOSIT", session.chainId)
  if (!source) return

  // Amount
  const amountStr = await askAmount("Amount to deposit", "tokens")
  if (!amountStr) return

  let destChainKey: ChainKey | undefined = selected.destinationChainKey
  if (!destChainKey) {
    const chosen = await askSelect("Destination chain", DESTINATION_CHAIN_OPTIONS as any)
    if (!chosen) return
    destChainKey = chosen as ChainKey
  } else {
    const useSuggested = await confirm(
      `Use suggested destination chain from selected route (${destChainKey})?`,
      true
    )
    if (!useSuggested) {
      const chosen = await askSelect("Destination chain", DESTINATION_CHAIN_OPTIONS as any)
      if (!chosen) return
      destChainKey = chosen as ChainKey
    }
  }
  if (!destChainKey) return

  const recipient = await askAddress("Recipient address on destination chain")
  if (!recipient) return

  // Summary
  hr()
  console.log(c.bold("  Deposit Summary"))
  console.log()
  console.log(`  Source:  ${c.bold(`${source.chainName} (${source.chainId})`)}`)
  console.log(`  Token:   ${c.bold(source.tokenLabel)} ${c.addr(shortAddr(source.token))}`)
  console.log(`  Vault:   ${c.bold(selected.title)}`)
  console.log(`  Amount:  ${c.value(amountStr)} tokens`)
  console.log(`  Action:  ${c.bold(selected.action ?? "deposit")}`)
  console.log()
  infoBox("Your tokens will be bridged cross-chain via CCIP then deposited into the vault automatically.")

  const ok = await confirm("Submit deposit?")
  if (!ok) { infoBox("Deposit cancelled."); await pressEnter(); return }

  const amountWei = parseUnits(amountStr, source.tokenDecimals)
  const hash = await createCrossVaultDeposit(session, {
    sourceChainId: source.chainId,
    token: source.token,
    amountWei,
    destinationChainKey: destChainKey,
    recipient,
    action: selected.action ?? "deposit",
  })
  if (hash) {
    successBox(`Deposit submitted. Tx: ${hash}`)
    infoBox("CrossVault transfer sent using programmable sender.")
  }

  await pressEnter()
}

// ─── View positions flow ──────────────────────────────────────────────────────

async function viewPositionsFlow(): Promise<void> {
  printHeader("My Vault Positions")
  infoBox("Positions are currently simulated for baseline orchestration testing.")

  // Mock positions — replace with real contract reads
  const mockPositions = [
    { vault: "Aave USDC / Amoy",    deposited: "1000.00", current: "1042.50", apy: "4.2%", days: 30 },
    { vault: "Yearn USDC / Base",   deposited: "500.00",  current: "520.83",  apy: "5.0%", days: 15 },
  ]

  if (mockPositions.length === 0) {
    infoBox("You have no active vault positions. Use 'Deposit' to get started.")
    await pressEnter()
    return
  }

  printTable(
    ["Vault", "Deposited", "Current Value", "APY", "Days"],
    mockPositions.map(p => [
      p.vault,
      `$${p.deposited}`,
      `$${p.current}`,
      c.success(p.apy),
      String(p.days),
    ])
  )

  await pressEnter()
}

// ─── Withdraw flow ────────────────────────────────────────────────────────────

async function withdrawFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("Withdraw from Vault")
  infoBox("Withdraw flow is currently simulated until CrossVault contract wiring is completed.")

  const vault = await askSelect(
    "Which vault to withdraw from?",
    VAULT_OPTIONS.map((v) => ({ title: v.title, value: v.value, description: v.description ?? "" }))
  )
  if (!vault) return

  const amountStr = await askAmount("Amount to withdraw (or 'all')", "tokens")
  if (!amountStr) return

  const ok = await confirm(`Withdraw ${amountStr} tokens from ${vault}?`, false)
  if (!ok) return

  // In production: call CrossVault contract
  infoBox("Withdrawal initiated. Tokens will be returned to your Sepolia wallet via CCIP.")

  await pressEnter()
}
