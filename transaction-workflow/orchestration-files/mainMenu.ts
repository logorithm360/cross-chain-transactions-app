// cli/screens/mainMenu.ts
// Screen 1 — The main hub. Shown after wallet connection and after returning
// from any sub-menu. Shows wallet status bar and routes to all four services.

import {
  printBanner,
  printWalletBar,
  printHeader,
  printMenu,
  hr,
  c,
  formatUnits,
} from "../utils/display.js"
import { askSelect }            from "../utils/input.js"
import type { WalletSession }   from "../wallet/connector.js"

export type MainMenuChoice =
  | "dca"
  | "transfer"
  | "vault"
  | "alerts"
  | "status"
  | "settings"
  | "quit"

export async function mainMenuScreen(session: WalletSession): Promise<MainMenuChoice | null> {
  printBanner()
  printWalletBar(
    session.address,
    session.chainName,
    session.balanceEth,
  )

  printHeader("Main Menu")

  const choice = await askSelect<MainMenuChoice>(
    "What would you like to do?",
    [
      {
        title:       "① AutoPilot DCA",
        value:       "dca",
        description: "Set up and manage AI-gated recurring cross-chain investments",
      },
      {
        title:       "② ChainShield Transfer",
        value:       "transfer",
        description: "Send tokens cross-chain with AI safety verification",
      },
      {
        title:       "③ CrossVault",
        value:       "vault",
        description: "Deposit into cross-chain yield strategies",
      },
      {
        title:       "④ ChainAlert Intelligence",
        value:       "alerts",
        description: "Monitor wallets and tokens — get AI-powered alerts",
      },
      {
        title:       "⑤ View all active services",
        value:       "status",
        description: "Dashboard — all orders, positions, and alert rules at a glance",
      },
      {
        title:       "⑥ Settings",
        value:       "settings",
        description: "Configure RPC URLs, workflow endpoints, notification webhooks",
      },
      {
        title:       "Quit",
        value:       "quit",
        description: "Exit CRE Suite",
      },
    ]
  )

  return choice
}
