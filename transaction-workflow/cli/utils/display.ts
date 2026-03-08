// cli/utils/display.ts
// All terminal output formatting — colours, banners, tables, status indicators.
// Uses kleur for ANSI colour codes (zero-dependency, fast).

import kleur from "kleur"

// ─── Colour aliases ───────────────────────────────────────────────────────────

export const c = {
  brand:   (s: string) => kleur.blue().bold(s),
  success: (s: string) => kleur.green(s),
  warn:    (s: string) => kleur.yellow(s),
  error:   (s: string) => kleur.red(s),
  dim:     (s: string) => kleur.gray(s),
  bold:    (s: string) => kleur.bold(s),
  key:     (s: string) => kleur.cyan().bold(s),       // menu keys like [1]
  addr:    (s: string) => kleur.magenta(s),            // wallet addresses
  link:    (s: string) => kleur.cyan().underline(s),   // URLs
  value:   (s: string) => kleur.white().bold(s),       // important values
}

// ─── Banner ───────────────────────────────────────────────────────────────────

export function printBanner(): void {
  console.clear()
  console.log()
  console.log(c.brand("  ╔═══════════════════════════════════════════════════╗"))
  console.log(c.brand("  ║         CRE Suite — Chainlink DeFi Terminal       ║"))
  console.log(c.brand("  ║   AutoPilot · ChainShield · CrossVault · Alerts   ║"))
  console.log(c.brand("  ╚═══════════════════════════════════════════════════╝"))
  console.log()
}

// ─── Section header ───────────────────────────────────────────────────────────

export function printHeader(title: string): void {
  const line = "─".repeat(title.length + 4)
  console.log()
  console.log(c.brand(`  ┌${line}┐`))
  console.log(c.brand(`  │  ${title}  │`))
  console.log(c.brand(`  └${line}┘`))
  console.log()
}

// ─── Wallet status bar ────────────────────────────────────────────────────────

export function printWalletBar(address: string, chainName: string, balance: string): void {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`
  console.log(
    c.dim("  Connected: ") +
    c.addr(short) +
    c.dim("  │  ") +
    c.bold(chainName) +
    c.dim("  │  ") +
    c.value(balance + " ETH")
  )
  console.log()
}

// ─── Menu rendering ───────────────────────────────────────────────────────────

export interface MenuItem {
  key:         string
  label:       string
  description: string
  disabled?:   boolean
}

export function printMenu(items: MenuItem[]): void {
  for (const item of items) {
    if (item.disabled) {
      console.log(c.dim(`  [${item.key}]  ${item.label} — ${item.description}`))
    } else {
      console.log(
        `  ${c.key(`[${item.key}]`)}  ${c.bold(item.label)}` +
        c.dim(`  —  ${item.description}`)
      )
    }
  }
  console.log()
}

// ─── Status badges ────────────────────────────────────────────────────────────

export function badge(status: string): string {
  const map: Record<string, string> = {
    ACTIVE:              kleur.green().bold(" ● ACTIVE "),
    PAUSED:              kleur.yellow().bold(" ⏸ PAUSED "),
    PAUSED_BY_WORKFLOW:  kleur.yellow().bold(" 🤖 AI PAUSED "),
    INSUFFICIENT_FUNDS:  kleur.red().bold(" ⚠ LOW FUNDS "),
    COMPLETED:           kleur.gray().bold(" ✓ DONE "),
    CANCELLED:           kleur.gray().bold(" ✗ CANCELLED "),
    PENDING:             kleur.blue().bold(" ⏳ PENDING "),
    CONFIRMED:           kleur.green().bold(" ✓ CONFIRMED "),
    FAILED:              kleur.red().bold(" ✗ FAILED "),
    SAFE:                kleur.green().bold(" ✓ SAFE "),
    SUSPICIOUS:          kleur.yellow().bold(" ⚠ SUSPICIOUS "),
    MALICIOUS:           kleur.red().bold(" ✗ MALICIOUS "),
    WATCHING:            kleur.blue().bold(" 👁 WATCHING "),
    TRIGGERED:           kleur.red().bold(" 🔔 TRIGGERED "),
    COOLING_DOWN:        kleur.yellow().bold(" 🕐 COOLING "),
  }
  return map[status] ?? kleur.gray(` ${status} `)
}

// ─── Simple table ─────────────────────────────────────────────────────────────

export function printTable(headers: string[], rows: string[][]): void {
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] ?? "").replace(/\x1b\[[0-9;]*m/g, "").length))
  )

  const divider = "  +" + widths.map(w => "-".repeat(w + 2)).join("+") + "+"
  const headerRow = "  |" + headers.map((h, i) => ` ${c.bold(h.padEnd(widths[i]))} `).join("|") + "|"

  console.log(c.dim(divider))
  console.log(headerRow)
  console.log(c.dim(divider))

  for (const row of rows) {
    const line = "  |" + row.map((cell, i) => {
      const plain = cell.replace(/\x1b\[[0-9;]*m/g, "")
      const pad   = " ".repeat(Math.max(0, widths[i] - plain.length))
      return ` ${cell}${pad} `
    }).join("|") + "|"
    console.log(line)
  }

  console.log(c.dim(divider))
  console.log()
}

// ─── Info / warning / error boxes ────────────────────────────────────────────

export function infoBox(message: string): void {
  console.log()
  console.log(c.brand("  ℹ  ") + message)
  console.log()
}

export function warnBox(message: string): void {
  console.log()
  console.log(c.warn("  ⚠  " + message))
  console.log()
}

export function errorBox(message: string): void {
  console.log()
  console.log(c.error("  ✗  " + message))
  console.log()
}

export function successBox(message: string): void {
  console.log()
  console.log(c.success("  ✓  " + message))
  console.log()
}

// ─── CCIP link display ────────────────────────────────────────────────────────

export function printCCIPLink(label: string, messageId: string): void {
  const url = `https://ccip.chain.link/msg/${messageId}`
  console.log(`  ${label}: ${c.link(url)}`)
}

// ─── Separator ────────────────────────────────────────────────────────────────

export function hr(): void {
  console.log(c.dim("  " + "─".repeat(55)))
}

// ─── Address shortener ────────────────────────────────────────────────────────

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

// ─── Format bigint token amounts ─────────────────────────────────────────────

export function formatUnits(value: bigint, decimals: number = 18): string {
  const str   = value.toString().padStart(decimals + 1, "0")
  const int   = str.slice(0, str.length - decimals) || "0"
  const frac  = str.slice(str.length - decimals).replace(/0+$/, "")
  return frac ? `${int}.${frac}` : int
}
