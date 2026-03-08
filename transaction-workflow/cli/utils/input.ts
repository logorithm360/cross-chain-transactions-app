// cli/utils/input.ts
// All user input helpers built on top of the `prompts` library.
// Every exported function is an async wrapper with validation baked in.

import prompts from "prompts"
import { c } from "./display.js"
import { isAddress } from "viem"

// ─── Signal handler — Ctrl+C cleanly exits any prompt ────────────────────────

let _cancelled = false

function onCancel(): void {
  _cancelled = true
}

export function wasCancelled(): boolean {
  const result = _cancelled
  _cancelled   = false
  return result
}

// ─── Core prompt wrappers ─────────────────────────────────────────────────────

// Single character keypress — used for main menus
export async function pressKey(
  message: string,
  choices: string[]
): Promise<string | null> {
  const { key } = await prompts({
    type:    "text",
    name:    "key",
    message: message + c.dim(` [${choices.join("/")}]`),
  }, { onCancel })

  if (wasCancelled() || !key) return null

  const normalised = key.toString().toLowerCase().trim()
  if (!choices.map(c => c.toLowerCase()).includes(normalised)) {
    console.log(c.warn(`  Invalid input. Please enter one of: ${choices.join(", ")}`))
    return pressKey(message, choices)
  }

  return normalised
}

// Free text input with optional validator
export async function askText(
  message: string,
  opts?: {
    initial?:   string
    validate?:  (v: string) => string | boolean
    hint?:      string
  }
): Promise<string | null> {
  const { value } = await prompts({
    type:     "text",
    name:     "value",
    message,
    initial:  opts?.initial,
    hint:     opts?.hint,
    validate: opts?.validate,
  }, { onCancel })

  if (wasCancelled()) return null
  return value ?? null
}

// Number input
export async function askNumber(
  message: string,
  opts?: {
    initial?: number
    min?:     number
    max?:     number
  }
): Promise<number | null> {
  const { value } = await prompts({
    type:    "number",
    name:    "value",
    message,
    initial: opts?.initial ?? 0,
    min:     opts?.min,
    max:     opts?.max,
    validate: (v: number) => {
      if (opts?.min !== undefined && v < opts.min) return `Minimum is ${opts.min}`
      if (opts?.max !== undefined && v > opts.max) return `Maximum is ${opts.max}`
      return true
    },
  }, { onCancel })

  if (wasCancelled() || value === undefined) return null
  return value
}

// Select from a list
export async function askSelect<T extends string>(
  message: string,
  choices: Array<{ title: string; value: T; description?: string; disabled?: boolean }>
): Promise<T | null> {
  const { value } = await prompts({
    type:    "select",
    name:    "value",
    message,
    choices: choices.map(c => ({
      title:       c.title,
      value:       c.value,
      description: c.description,
      disabled:    c.disabled,
    })),
  }, { onCancel })

  if (wasCancelled() || value === undefined) return null
  return value
}

// Multi-select from a list
export async function askMultiSelect<T extends string>(
  message: string,
  choices: Array<{ title: string; value: T; description?: string }>
): Promise<T[] | null> {
  const { value } = await prompts({
    type:    "multiselect",
    name:    "value",
    message,
    choices,
    min:     1,
    hint:    "Space to select, Enter to confirm",
  }, { onCancel })

  if (wasCancelled() || !value) return null
  return value
}

// Yes/No confirmation
export async function confirm(message: string, initial: boolean = true): Promise<boolean> {
  const { value } = await prompts({
    type:    "confirm",
    name:    "value",
    message,
    initial,
  }, { onCancel })

  if (wasCancelled()) return false
  return value ?? false
}

// Password / secret input (masked)
export async function askSecret(message: string): Promise<string | null> {
  const { value } = await prompts({
    type:    "password",
    name:    "value",
    message,
  }, { onCancel })

  if (wasCancelled()) return null
  return value ?? null
}

// ─── Domain-specific validators ───────────────────────────────────────────────

export function validateAddress(v: string): string | boolean {
  if (!v.startsWith("0x") || !isAddress(v)) return "Enter a valid EVM address (0x...)"
  return true
}

export function validatePositiveAmount(v: string): string | boolean {
  const n = parseFloat(v)
  if (isNaN(n) || n <= 0) return "Enter a positive number"
  return true
}

export function validatePrivateKey(v: string): string | boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return "Enter a valid private key (0x + 64 hex chars)"
  return true
}

// ─── Ask for an EVM address ───────────────────────────────────────────────────

export async function askAddress(message: string): Promise<`0x${string}` | null> {
  const value = await askText(message, { validate: validateAddress })
  return value as `0x${string}` | null
}

// ─── Ask for a token amount and return parsed string ─────────────────────────

export async function askAmount(
  message: string,
  symbol: string
): Promise<string | null> {
  return askText(`${message} (${symbol})`, {
    validate: validatePositiveAmount,
    hint:     `e.g. 10.5`,
  })
}

// ─── Press Enter to continue ──────────────────────────────────────────────────

export async function pressEnter(message: string = "Press Enter to continue"): Promise<void> {
  await prompts({ type: "invisible", name: "_", message: c.dim(message) })
}
