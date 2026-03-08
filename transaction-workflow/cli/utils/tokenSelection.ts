import {
  CHAINS,
  SUPPORTED_SOURCE_CHAINS_BY_ACTION,
  TOKEN_PRESETS_BY_CHAIN_ID,
  type ChainKey,
  type TokenPreset,
} from "../config.js"
import type { ServiceAction } from "../../shared/intents.js"
import { shortAddr } from "./display.js"
import { askAddress, askNumber, askSelect } from "./input.js"

export interface SourceChainSelection {
  chainId: number
  chainKey: ChainKey
  chainName: string
}

export interface SourceTokenSelection extends SourceChainSelection {
  token: `0x${string}`
  tokenDecimals: number
  tokenLabel: string
}

function chainKeyFromId(chainId: number): ChainKey | null {
  const entry = Object.entries(CHAINS).find(([, chain]) => chain.chainId === chainId)
  return entry ? (entry[0] as ChainKey) : null
}

export function getSupportedSourceChains(action: ServiceAction): SourceChainSelection[] {
  const ids = SUPPORTED_SOURCE_CHAINS_BY_ACTION[action] ?? []
  const supported: SourceChainSelection[] = []

  for (const chainId of ids) {
    const chainKey = chainKeyFromId(chainId)
    if (!chainKey) continue
    supported.push({
      chainId,
      chainKey,
      chainName: CHAINS[chainKey].name,
    })
  }

  return supported
}

export async function askSourceChain(
  action: ServiceAction,
  currentSessionChainId?: number
): Promise<SourceChainSelection | null> {
  const supported = getSupportedSourceChains(action)
  if (supported.length === 0) {
    throw new Error(`No source chains configured for ${action}`)
  }

  const preferred = supported.find((chain) => chain.chainId === currentSessionChainId)
  const options = supported.map((chain) => ({
    title: `${chain.chainName} (${chain.chainId})`,
    value: String(chain.chainId),
    description:
      chain.chainId === currentSessionChainId
        ? "Current connected network"
        : "MetaMask can switch to this chain during signing",
  }))

  const selected = await askSelect("Source network", options)
  if (!selected) return null

  const chainId = Number(selected)
  return supported.find((chain) => chain.chainId === chainId) ?? preferred ?? supported[0]
}

function renderPresetTitle(preset: TokenPreset): string {
  return `${preset.label}  (${shortAddr(preset.address)})`
}

export async function askTokenForChain(chainId: number): Promise<{
  token: `0x${string}`
  tokenDecimals: number
  tokenLabel: string
} | null> {
  const presets = TOKEN_PRESETS_BY_CHAIN_ID[chainId] ?? []
  const manualValue = "__manual__"

  if (presets.length > 0) {
    const choice = await askSelect("Token", [
      ...presets.map((preset, index) => ({
        title: renderPresetTitle(preset),
        value: `preset:${index}`,
        description: `${preset.symbol} · ${preset.decimals} decimals`,
      })),
      {
        title: "Custom token address",
        value: manualValue,
        description: "Enter a token contract manually",
      },
    ])
    if (!choice) return null

    if (choice !== manualValue) {
      const index = Number(choice.split(":")[1] ?? "-1")
      const preset = presets[index]
      if (!preset) return null
      return {
        token: preset.address,
        tokenDecimals: preset.decimals,
        tokenLabel: preset.label,
      }
    }
  }

  const token = await askAddress("Token contract address")
  if (!token) return null
  const tokenDecimals = await askNumber("Token decimals", { min: 0, max: 36, initial: 18 })
  if (tokenDecimals === null) return null

  return {
    token,
    tokenDecimals,
    tokenLabel: `Custom token (${shortAddr(token)})`,
  }
}

export async function askSourceChainAndToken(
  action: ServiceAction,
  currentSessionChainId?: number
): Promise<SourceTokenSelection | null> {
  const source = await askSourceChain(action, currentSessionChainId)
  if (!source) return null

  const token = await askTokenForChain(source.chainId)
  if (!token) return null

  return {
    ...source,
    ...token,
  }
}
