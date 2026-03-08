#!/usr/bin/env bun
// cli/index.ts
// CRE Suite — main entry point.
//
// Run with:
//   bun run cli/index.ts
//   or
//   cre-suite          (if installed globally via `bun link`)
//
// This file owns the top-level loop:
//   1. Show welcome screen → connect wallet
//   2. Show main menu → user picks a service
//   3. Run the service screen (full interactive sub-menu)
//   4. Return to main menu when user presses Back
//   5. Quit cleanly on Q or Ctrl+C

import { welcomeScreen }  from "./screens/welcome.js"
import { mainMenuScreen } from "./screens/mainMenu.js"
import { dcaScreen }      from "./screens/dca.js"
import { transferScreen } from "./screens/transfer.js"
import { vaultScreen }    from "./screens/vault.js"
import { alertsScreen }   from "./screens/alerts.js"
import { statusScreen }   from "./screens/status.js"
import { c }              from "./utils/display.js"
import type { WalletSession } from "./wallet/connector.js"
import { startBridgeServer } from "./bridge/runtime.js"
import { loadCliEnv } from "./env.js"

// ─── Graceful Ctrl+C handling ─────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log()
  console.log(c.dim("  Exiting CRE Suite. Goodbye."))
  process.exit(0)
})

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadCliEnv()

  // Start localhost bridge for MetaMask web signer.
  startBridgeServer()

  // Step 1 — Welcome + wallet connection
  const session: WalletSession | null = await welcomeScreen()

  if (!session) {
    console.log(c.dim("  No wallet connected. Exiting."))
    process.exit(0)
  }

  // Step 2 — Main menu loop
  while (true) {
    const choice = await mainMenuScreen(session)

    if (!choice || choice === "quit") {
      console.log()
      console.log(c.dim("  Goodbye."))
      break
    }

    // Step 3 — Route to service screen
    switch (choice) {
      case "dca":      await dcaScreen(session);      break
      case "transfer": await transferScreen(session); break
      case "vault":    await vaultScreen(session);    break
      case "alerts":   await alertsScreen(session);   break
      case "status":   await statusScreen(session);   break

      case "settings":
        console.log()
        console.log(c.dim("  Settings: edit cli/config.ts and set environment variables in .env"))
        console.log(c.dim("  Required env vars:"))
        console.log(c.dim("    SEPOLIA_RPC_URL, AUTOMATED_TRADER_ADDRESS, CHAIN_ALERT_REGISTRY_ADDRESS"))
        console.log(c.dim("    TOKEN_TRANSFER_SENDER_ADDRESS, PROGRAMMABLE_TOKEN_SENDER_ADDRESS"))
        console.log(c.dim("    ORCHESTRATOR_BRIDGE_PORT, ORCHESTRATOR_ALLOWED_ORIGINS"))
        console.log()
        await import("./utils/input.js").then(m => m.pressEnter())
        break
    }

    // After returning from any screen, loop back to main menu automatically
  }

  process.exit(0)
}

main().catch(err => {
  console.error(c.error("  Fatal error: "), err)
  process.exit(1)
})
