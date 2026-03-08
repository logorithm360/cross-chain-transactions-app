// cli/screens/transfer.ts
// ChainShield Transfer — cross-chain token transfer with AI safety verification.
//
// Sub-menus:
//   [1] New transfer
//   [2] Track existing transfer (by CCIP message ID)
//   [B] Back

import ora from "ora"
import {
  printBanner, printHeader, printWalletBar,
  badge, successBox, errorBox, infoBox,
  warnBox, hr, c, shortAddr, printCCIPLink,
} from "../utils/display.js"
import {
  askSelect, askText, askAddress, askAmount,
  confirm, pressEnter,
} from "../utils/input.js"
import { askSourceChainAndToken } from "../utils/tokenSelection.js"
import type { WalletSession }  from "../wallet/connector.js"
import { requireSigning }      from "../wallet/connector.js"
import { DESTINATION_CHAIN_OPTIONS, WORKFLOW_ENDPOINTS, buildCCIPLink } from "../config.js"
import { parseUnits } from "viem"
import { createChainShieldTransfer } from "../contracts/writer.js"

// ─── Main transfer screen loop ────────────────────────────────────────────────

export async function transferScreen(session: WalletSession): Promise<void> {
  while (true) {
    printBanner()
    printWalletBar(session.address, session.chainName, session.balanceEth)
    printHeader("② ChainShield Transfer — AI-Verified Cross-Chain Sends")

    const choice = await askSelect("What would you like to do?", [
      { title: "New transfer",              value: "new",   description: "Send tokens cross-chain with AI verification" },
      { title: "Track existing transfer",   value: "track", description: "Check status of a previous transfer by message ID" },
      { title: "← Back to main menu",      value: "back",  description: "" },
    ])

    if (!choice || choice === "back") return

    switch (choice) {
      case "new":   await newTransferFlow(session); break
      case "track": await trackTransferFlow();      break
    }
  }
}

// ─── New transfer flow ────────────────────────────────────────────────────────

async function newTransferFlow(session: WalletSession): Promise<void> {
  if (!requireSigning(session)) { await pressEnter(); return }

  printHeader("New Cross-Chain Transfer")

  // Source network + token
  const source = await askSourceChainAndToken("CHAINSHIELD_TRANSFER", session.chainId)
  if (!source) return

  // Amount
  const amountStr = await askAmount("Amount to send", "tokens")
  if (!amountStr) return

  // Destination chain
  const destChainKey = await askSelect("Destination chain", DESTINATION_CHAIN_OPTIONS as any)
  if (!destChainKey) return

  // Recipient
  const recipient = await askAddress("Recipient address on destination chain")
  if (!recipient) return

  // Action on arrival
  const action = await askSelect("What happens with the tokens on arrival?", [
    { title: "Transfer  — receive in wallet",    value: "transfer" },
    { title: "Stake     — stake immediately",    value: "stake"    },
    { title: "Swap      — swap to native gas",   value: "swap"     },
    { title: "Deposit   — deposit to vault",     value: "deposit"  },
  ])
  if (!action) return

  // AI verification check
  hr()
  const verifySpinner = ora("  Running AI safety verification on token...").start()

  await new Promise(r => setTimeout(r, 1500)) // simulate API call

  // In production: call TokenVerifier.sol or the ChainShield workflow endpoint
  // const verificationResult = await callWorkflowEndpoint(WORKFLOW_ENDPOINTS.chainShield, {...})
  const mockVerdict: string = "SAFE"   // replace with real result

  if (mockVerdict === "MALICIOUS") {
    verifySpinner.fail("  AI verification: TOKEN FLAGGED AS MALICIOUS")
    errorBox("This token has been flagged. The transfer has been blocked for your safety.")
    await pressEnter()
    return
  } else if (mockVerdict === "SUSPICIOUS") {
    verifySpinner.warn("  AI verification: SUSPICIOUS")
    warnBox("This token has unusual characteristics. Proceed with caution.")
  } else {
    verifySpinner.succeed("  AI verification: SAFE — token cleared")
  }

  // Summary
  hr()
  console.log(c.bold("  Transfer Summary"))
  console.log()
  console.log(`  Source:      ${c.bold(`${source.chainName} (${source.chainId})`)}`)
  console.log(`  Token:       ${c.bold(source.tokenLabel)} ${c.addr(shortAddr(source.token))}`)
  console.log(`  Amount:      ${c.value(amountStr)} tokens`)
  console.log(`  Destination: ${c.bold(DESTINATION_CHAIN_OPTIONS.find(d => d.value === destChainKey)?.title ?? destChainKey)}`)
  console.log(`  Recipient:   ${c.addr(shortAddr(recipient))}`)
  console.log(`  Action:      ${c.bold(action)}`)
  console.log(`  Verdict:     ${badge(mockVerdict)}`)
  console.log()

  const ok = await confirm("Submit this transfer?")
  if (!ok) { infoBox("Transfer cancelled."); await pressEnter(); return }

  const amountWei = parseUnits(amountStr, source.tokenDecimals)
  const hash = await createChainShieldTransfer(session, {
    sourceChainId: source.chainId,
    token: source.token,
    amountWei,
    destinationChainKey: destChainKey,
    recipient,
  })

  if (hash) {
    successBox(`Transfer submitted. Tx: ${hash}`)
    infoBox("Use 'Track existing transfer' with the CCIP message ID from contract events/explorer.")
  }

  await pressEnter()
}

// ─── Track transfer flow ──────────────────────────────────────────────────────

async function trackTransferFlow(): Promise<void> {
  printHeader("Track Transfer")
  infoBox("Tracking uses CCIP Explorer links in this baseline. Destination contract reconciliation is pending.")

  const messageId = await askText(
    "Enter CCIP message ID  (0x...)",
    { hint: "Found in your previous transfer confirmation" }
  )
  if (!messageId) return

  const link = buildCCIPLink(messageId)

  hr()
  console.log(c.bold("  CCIP Explorer Link:"))
  console.log()
  printCCIPLink("  View transfer", messageId)
  console.log()
  infoBox("Open the link above in your browser to see full delivery status, source and destination transaction hashes, and token amounts.")

  await pressEnter()
}
