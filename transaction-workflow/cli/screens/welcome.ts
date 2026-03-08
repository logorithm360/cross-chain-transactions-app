// cli/screens/welcome.ts
// Screen 0 — app entry point before main menu.
// Connect wallet using one of the supported connection modes.

import {
  printBanner,
  printHeader,
  infoBox,
  c,
} from "../utils/display.js"
import { askSelect, pressEnter } from "../utils/input.js"
import { connect, type WalletSession } from "../wallet/connector.js"

export async function welcomeScreen(): Promise<WalletSession | null> {
  while (true) {
    printBanner()
    printHeader("Welcome to CRE Suite")

    console.log(c.dim("  A local CLI orchestrator for all four services."))
    console.log(c.dim("  Connect a wallet to continue."))
    console.log()

    const action = await askSelect("Choose an action", [
      {
        title: "Connect wallet",
        value: "connect",
        description: "Private key, MetaMask web signer, or read-only mode",
      },
      {
        title: "What this app does",
        value: "about",
        description: "Quick overview of service orchestration behavior",
      },
      {
        title: "Quit",
        value: "quit",
        description: "Exit CRE Suite",
      },
    ])

    if (!action || action === "quit") return null

    if (action === "about") {
      infoBox(
        "This CLI orchestrates AutoPilot DCA, ChainShield Transfer, CrossVault, " +
        "and ChainAlert from one interface. CRE workflows run remotely; this app " +
        "handles local interaction, validation, and on-chain calls."
      )
      await pressEnter()
      continue
    }

    const session = await connect()
    if (session) return session

    infoBox("Wallet connection was cancelled. You can try again or quit.")
    await pressEnter()
  }
}
