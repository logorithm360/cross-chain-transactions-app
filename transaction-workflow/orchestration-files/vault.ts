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
  infoBox, hr, c, formatUnits,
} from "../utils/display.js"
import {
  askSelect, askAmount, askAddress,
  confirm, pressEnter,
} from "../utils/input.js"
import type { WalletSession }  from "../wallet/connector.js"
import { requireSigning }      from "../wallet/connector.js"
import { DESTINATION_CHAIN_OPTIONS } from "../config.js"

// ─── Mock vault options (replace with real protocol registry) ─────────────────

const VAULT_OPTIONS = [
  { title: "Aave USDC — Polygon Amoy      (~4.2% APY)",  value: "aave-amoy-usdc"    },
  { title: "Compound ETH — Arbitrum Sep   (~3.1% APY)",  value: "compound-arb-eth"  },
  { title: "Yearn USDC — Base Sepolia     (~5.0% APY)",  value: "yearn-base-usdc"   },
  { title: "Benqi AVAX — Avalanche Fuji   (~6.8% APY)",  value: "benqi-fuji-avax"   },
]

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

  // Select vault (protocol + chain)
  const vault = await askSelect("Select a yield vault", VAULT_OPTIONS)
  if (!vault) return

  // Token to deposit
  const tokenAddr = await askAddress("Token contract address to deposit (on Sepolia)")
  if (!tokenAddr) return

  // Amount
  const amountStr = await askAmount("Amount to deposit", "tokens")
  if (!amountStr) return

  // Summary
  hr()
  const selected = VAULT_OPTIONS.find(v => v.value === vault)
  console.log(c.bold("  Deposit Summary"))
  console.log()
  console.log(`  Vault:   ${c.bold(selected?.title ?? vault)}`)
  console.log(`  Amount:  ${c.value(amountStr)} tokens`)
  console.log()
  infoBox("Your tokens will be bridged cross-chain via CCIP then deposited into the vault automatically.")

  const ok = await confirm("Submit deposit?")
  if (!ok) { infoBox("Deposit cancelled."); await pressEnter(); return }

  // In production: call CrossVault contract or workflow HTTP endpoint
  infoBox("Deposit submitted. The CrossVault workflow will bridge your tokens and confirm the deposit.")
  infoBox("Your position will appear in 'View my positions' once CCIP confirms delivery.")

  await pressEnter()
}

// ─── View positions flow ──────────────────────────────────────────────────────

async function viewPositionsFlow(): Promise<void> {
  printHeader("My Vault Positions")

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

  const vault = await askSelect("Which vault to withdraw from?", VAULT_OPTIONS)
  if (!vault) return

  const amountStr = await askAmount("Amount to withdraw (or 'all')", "tokens")
  if (!amountStr) return

  const ok = await confirm(`Withdraw ${amountStr} tokens from ${vault}?`, false)
  if (!ok) return

  // In production: call CrossVault contract
  infoBox("Withdrawal initiated. Tokens will be returned to your Sepolia wallet via CCIP.")

  await pressEnter()
}
