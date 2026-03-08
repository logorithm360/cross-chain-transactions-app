import { useEffect, useMemo, useRef, useState } from "react"

type ServiceType = "DCA" | "CHAINSHIELD" | "CROSSVAULT" | "CHAINALERT"
type ServiceAction =
  | "DCA_CREATE_TIMED_ORDER"
  | "DCA_SET_ORDER_PAUSED"
  | "DCA_CANCEL_ORDER"
  | "DCA_FUND_LINK"
  | "CHAINSHIELD_TRANSFER"
  | "CROSSVAULT_DEPOSIT"
  | "CHAINALERT_UPSERT_RULE"
  | "CHAINALERT_SET_RULE_ENABLED"

type IntentStatus =
  | "CREATED"
  | "SIGN_REQUESTED"
  | "SUBMITTED"
  | "CONFIRMED"
  | "FAILED"
  | "EXPIRED"

type IntentExecutionMode = "PUBLIC_EVM" | "CONFIDENTIAL_PRIVATE"
type IntentPrivacyOutcome = "EXPLORER_VISIBLE" | "EXPLORER_NOT_APPLICABLE"

type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
  isConnected?: () => boolean
  isMetaMask?: boolean
}

type Eip6963ProviderDetail = {
  info: { rdns: string; uuid: string; name: string; icon: string }
  provider: Eip1193Provider
}

type WindowWithEthereum = Window & {
  ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] }
}

type ChainInfo = {
  name: string
  chainId: number
  chainIdHex: `0x${string}`
  selector: string
  rpcUrl: string
  blockExplorer: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
}

type TokenPreset = {
  symbol: string
  label: string
  address: `0x${string}`
  decimals: number
}

type ConfidentialEip712Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

type ConfidentialMode = {
  enabled: boolean
  strict: boolean
  provider: "CONVERGENCE_2026_TOKEN_API"
  tokenApiBaseUrl: string
  hideSenderDefault: boolean
  eip712Domain: ConfidentialEip712Domain
}

type BuiltWithConfidentialMode = {
  enabled: boolean
  strict: boolean
  provider: "CONVERGENCE_2026_TOKEN_API"
}

type ConfidentialSubmissionRef = {
  provider: "CONVERGENCE_2026_TOKEN_API"
  privateTransferId: string
  submittedAt: string
}

type SessionState = {
  sessionId: string
  expiresAt: string
  walletContext: {
    account: `0x${string}`
    chainId: number
    chainIdHex: `0x${string}`
    providerId?: string
    providerName?: string
  } | null
  intents: PreparedIntentBundle[]
  chains: Record<string, ChainInfo>
  tokenPresetsByChainId: Record<string, TokenPreset[]>
  supportedSourceChainsByAction: Record<string, number[]>
  confidentialMode: ConfidentialMode
}

type PreparedTransaction = {
  txId: string
  chainId: number
  chainIdHex: `0x${string}`
  to: `0x${string}`
  data: `0x${string}`
  value: `0x${string}`
  description: string
}

type PreparedIntentBundle = {
  intentId: string
  sessionId: string
  nonce: string
  serviceType: ServiceType
  action: ServiceAction
  status: IntentStatus
  executionMode: IntentExecutionMode
  privacyOutcome: IntentPrivacyOutcome
  builtWithConfidentialMode: BuiltWithConfidentialMode
  createdAt: string
  expiresAt: string
  transactions: PreparedTransaction[]
  params: Record<string, unknown>
  submittedTxHash?: `0x${string}`
  confidentialRef?: ConfidentialSubmissionRef
  error?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomNonce(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function actionTitle(action: ServiceAction): string {
  switch (action) {
    case "DCA_CREATE_TIMED_ORDER":
      return "AutoPilot DCA"
    case "DCA_SET_ORDER_PAUSED":
      return "AutoPilot DCA Pause/Resume"
    case "DCA_CANCEL_ORDER":
      return "AutoPilot DCA Cancel"
    case "DCA_FUND_LINK":
      return "AutoPilot DCA LINK Funding"
    case "CHAINSHIELD_TRANSFER":
      return "ChainShield Transfer"
    case "CROSSVAULT_DEPOSIT":
      return "CrossVault Deposit"
    case "CHAINALERT_UPSERT_RULE":
      return "ChainAlert Rule"
    case "CHAINALERT_SET_RULE_ENABLED":
      return "ChainAlert Toggle Rule"
    default:
      return action
  }
}

function shortAddr(value: string): string {
  if (!value || value.length < 10) return value
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

function supportsConfidentialTransfer(action: ServiceAction): boolean {
  return action === "CHAINSHIELD_TRANSFER" || action === "CROSSVAULT_DEPOSIT"
}

function isPublicOnChainAction(action: ServiceAction): boolean {
  return (
    action === "DCA_CREATE_TIMED_ORDER" ||
    action === "DCA_SET_ORDER_PAUSED" ||
    action === "DCA_CANCEL_ORDER" ||
    action === "DCA_FUND_LINK" ||
    action === "CHAINALERT_UPSERT_RULE" ||
    action === "CHAINALERT_SET_RULE_ENABLED"
  )
}

function modeBadgeLabel(intent: PreparedIntentBundle): string {
  return intent.executionMode === "CONFIDENTIAL_PRIVATE" ? "Private Execution" : "Public On-Chain"
}

function pickPreferredProviderId(list: Eip6963ProviderDetail[]): string {
  if (list.length === 0) return ""
  const metamask = list.find(
    (p) =>
      p.provider.isMetaMask ||
      p.info.rdns.toLowerCase().includes("metamask") ||
      p.info.name.toLowerCase().includes("metamask")
  )
  return (metamask ?? list[0]).info.uuid
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value
  if (value instanceof Error) return value.message || String(value)
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

function formatRpcError(err: unknown): string {
  if (err instanceof Error) return err.message || String(err)
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const e = err as { message?: string; shortMessage?: string; code?: number }
    const head = e.shortMessage || e.message || formatUnknown(err)
    return typeof e.code === "number" ? `${head} (code ${e.code})` : head
  }
  return String(err)
}

function isAddressLike(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

function utf8ToHex(value: string): `0x${string}` {
  const bytes = new TextEncoder().encode(value)
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return `0x${hex}` as `0x${string}`
}

export default function App() {
  const SYSTEM_NAME = "ChainPilot Nexus"
  const SYSTEM_TAGLINE = "Unified cross-chain automation signer for DCA, transfers, vault routes, and alert rules."

  const query = useMemo(() => new URLSearchParams(window.location.search), [])
  const queryBridge = query.get("bridge") ?? "http://127.0.0.1:8787"
  const querySessionId = query.get("sessionId") ?? ""
  const queryToken = query.get("token") ?? ""
  const isCliLinkedSession = querySessionId.length > 0 && queryToken.length > 0
  const [bridgeBaseUrl, setBridgeBaseUrl] = useState(queryBridge)
  const [sessionId, setSessionId] = useState(querySessionId)
  const [token, setToken] = useState(queryToken)

  const [providers, setProviders] = useState<Eip6963ProviderDetail[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState<string>("")
  const [walletAddress, setWalletAddress] = useState<string>("")
  const [walletChainHex, setWalletChainHex] = useState<string>("")
  const [state, setState] = useState<SessionState | null>(null)
  const [busy, setBusy] = useState(false)
  const [logs, setLogs] = useState<string[]>(["Ready"])
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null)
  const [selectedSourceChainId, setSelectedSourceChainId] = useState<number>(11155111)
  const cliLinkLoggedRef = useRef(false)

  const [dca, setDca] = useState({
    destinationChainKey: "amoy",
    recipient: "",
    intervalSeconds: "3600",
    maxExecutions: "0",
    action: "transfer",
    amount: "1",
  })
  const [alert, setAlert] = useState({
    ruleId: "0",
    alertType: "11",
    cooldownSeconds: "3600",
    rearmSeconds: "0",
    paramsJson: "{\"wallet\":\"0x...\",\"threshold_usd\":1000}",
  })

  const [selectedTokens, setSelectedTokens] = useState<Partial<Record<ServiceAction, string>>>({
    DCA_CREATE_TIMED_ORDER: "",
    CHAINSHIELD_TRANSFER: "",
    CROSSVAULT_DEPOSIT: "",
    CHAINALERT_UPSERT_RULE: "",
  })

  const selectedProvider = useMemo(
    () => providers.find((p) => p.info.uuid === selectedProviderId)?.provider,
    [providers, selectedProviderId]
  )
  const isWalletConnected = Boolean(walletAddress || state?.walletContext?.account)

  const chainOptions = useMemo(
    () => Object.values(state?.chains ?? {}).sort((a, b) => a.chainId - b.chainId),
    [state]
  )

  const destinationChainOptions = useMemo(
    () => Object.keys(state?.chains ?? {}).filter((k) => k !== "sepolia"),
    [state]
  )

  const sourceTokens = useMemo(() => {
    const byId = state?.tokenPresetsByChainId ?? {}
    return byId[String(selectedSourceChainId)] ?? []
  }, [state, selectedSourceChainId])

  function appendLog(message: string) {
    const line = `${new Date().toISOString()}  ${message}`
    setLogs((prev) => [line, ...prev].slice(0, 80))
  }

  useEffect(() => {
    if (sourceTokens.length === 0) return
    setSelectedTokens((prev) => {
      const next = { ...prev }
      for (const action of Object.keys(next) as ServiceAction[]) {
        if (!next[action]) next[action] = sourceTokens[0].address
      }
      return next
    })
  }, [sourceTokens])

  function serviceAllowedOnSelectedChain(action: ServiceAction): boolean {
    const map = state?.supportedSourceChainsByAction ?? {}
    const allowed = map[action] ?? []
    return allowed.includes(selectedSourceChainId)
  }

  async function api(path: string, method: "GET" | "POST" = "GET", body?: Record<string, unknown>) {
    const res = await fetch(`${bridgeBaseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-session-token": token,
      },
      body: method === "POST" ? JSON.stringify({ sessionId, ...body }) : undefined,
    })
    const json = (await res.json()) as Record<string, unknown>
    if (!res.ok) {
      const detail = json.error ?? json.message ?? json
      throw new Error(`HTTP ${res.status}: ${formatUnknown(detail)}`)
    }
    return json
  }

  async function loadSessionState() {
    if (!sessionId || !token) return
    const json = (await api("/session/state")) as unknown as SessionState
    setState(json)
    if (json.walletContext?.chainId) setSelectedSourceChainId(json.walletContext.chainId)
  }

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail
      setProviders((prev) => {
        if (prev.some((p) => p.info.uuid === detail.info.uuid)) return prev
        return [...prev, detail]
      })
    }
    window.addEventListener("eip6963:announceProvider", handler as EventListener)
    window.dispatchEvent(new Event("eip6963:requestProvider"))

    // Fallback for legacy injected providers where EIP-6963 announcements are absent.
    const fallbackTimer = window.setTimeout(() => {
      const injected = (window as WindowWithEthereum).ethereum
      if (!injected) return
      const candidates = Array.isArray(injected.providers) ? injected.providers : [injected]
      const picked = candidates.find((p) => p?.isMetaMask) ?? injected
      setProviders((prev) => {
        if (prev.length > 0) return prev
        return [
          {
            info: {
              rdns: picked.isMetaMask ? "io.metamask.legacy" : "injected.legacy",
              uuid: "legacy-injected-provider",
              name: picked.isMetaMask ? "MetaMask" : "Injected Wallet",
              icon: "",
            },
            provider: picked,
          },
        ]
      })
    }, 500)

    return () => {
      window.removeEventListener("eip6963:announceProvider", handler as EventListener)
      window.clearTimeout(fallbackTimer)
    }
  }, [])

  useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProviderId(pickPreferredProviderId(providers))
    }
  }, [providers, selectedProviderId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!selectedProvider?.on) return
    const handleAccountsChanged = (accounts: unknown) => {
      if (!Array.isArray(accounts) || accounts.length === 0) {
        setWalletAddress("")
        appendLog("Wallet disconnected from provider (accountsChanged).")
        return
      }
      const account = String(accounts[0])
      setWalletAddress(account)
      appendLog(`Wallet account changed: ${account}`)
    }
    const handleChainChanged = (chainHex: unknown) => {
      if (typeof chainHex !== "string") return
      setWalletChainHex(chainHex)
      const chainId = Number.parseInt(chainHex, 16)
      if (Number.isFinite(chainId)) setSelectedSourceChainId(chainId)
      appendLog(`Wallet chain changed: ${chainHex}`)
    }
    selectedProvider.on("accountsChanged", handleAccountsChanged)
    selectedProvider.on("chainChanged", handleChainChanged)
    return () => {
      selectedProvider.removeListener?.("accountsChanged", handleAccountsChanged)
      selectedProvider.removeListener?.("chainChanged", handleChainChanged)
    }
  }, [selectedProvider])

  useEffect(() => {
    if (!sessionId || !token) return
    loadSessionState().catch((err) => appendLog(`State load failed: ${String(err)}`))

    const es = new EventSource(
      `${bridgeBaseUrl}/events?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`
    )
    const refresh = () => loadSessionState().catch(() => undefined)
    const names = [
      "SESSION_WALLET_UPDATED",
      "SESSION_CONFIDENTIAL_MODE_UPDATED",
      "INTENT_CREATED",
      "INTENT_SUBMITTED",
      "INTENT_CONFIDENTIAL_SUBMITTED",
      "INTENT_CONFIRMED",
      "INTENT_CONFIDENTIAL_CONFIRMED",
      "INTENT_FAILED",
      "INTENT_CONFIDENTIAL_FAILED",
      "INTENT_EXPIRED",
    ]

    const onEvent = (event: Event) => {
      const message = event as MessageEvent<string>
      try {
        const parsed = JSON.parse(message.data ?? "{}") as {
          type?: string
          intentId?: string
          payload?: Record<string, unknown>
        }
        if (parsed.type === "SESSION_CONFIDENTIAL_MODE_UPDATED") {
          appendLog(
            `Confidential mode updated -> ${parsed.payload?.enabled ? "ACTIVE" : "INACTIVE"}`
          )
        } else if (parsed.type === "INTENT_CREATED") {
          appendLog(
            `Intent created: ${shortAddr(parsed.intentId ?? "")} mode=${String(parsed.payload?.executionMode ?? "-")}`
          )
        } else if (parsed.type === "INTENT_CONFIDENTIAL_SUBMITTED") {
          const ref = parsed.payload?.confidentialRef as { privateTransferId?: string } | undefined
          appendLog(
            `Confidential submit: ${shortAddr(parsed.intentId ?? "")} id=${ref?.privateTransferId ?? "-"}`
          )
        } else if (parsed.type === "INTENT_CONFIDENTIAL_CONFIRMED") {
          appendLog(`Confidential confirm: ${shortAddr(parsed.intentId ?? "")}`)
        } else if (parsed.type === "INTENT_CONFIDENTIAL_FAILED") {
          appendLog(`Confidential failed: ${shortAddr(parsed.intentId ?? "")}`)
        } else if (parsed.type === "INTENT_SUBMITTED") {
          appendLog(`Public tx submitted: ${shortAddr(parsed.intentId ?? "")}`)
        } else if (parsed.type === "INTENT_CONFIRMED") {
          appendLog(`Public tx confirmed: ${shortAddr(parsed.intentId ?? "")}`)
        } else if (parsed.type === "INTENT_FAILED") {
          appendLog(`Intent failed: ${shortAddr(parsed.intentId ?? "")}`)
        }
      } catch {
        appendLog(`Bridge event received: ${event.type}`)
      }
      refresh()
    }

    for (const name of names) es.addEventListener(name, onEvent)
    es.onerror = () => appendLog("Bridge events disconnected; refresh manually if needed.")
    return () => {
      for (const name of names) es.removeEventListener(name, onEvent)
      es.close()
    }
  }, [bridgeBaseUrl, sessionId, token])

  useEffect(() => {
    if (isCliLinkedSession && !cliLinkLoggedRef.current) {
      cliLinkLoggedRef.current = true
      appendLog(`CLI-linked session detected: ${shortAddr(querySessionId)} @ ${queryBridge}`)
    }
  }, [isCliLinkedSession, querySessionId, queryBridge])

  async function connectWallet() {
    setBusy(true)
    try {
      if (providers.length === 0) {
        throw new Error("No injected wallet provider detected. Unlock MetaMask and refresh the page.")
      }
      const provider =
        selectedProvider ?? providers.find((p) => p.info.uuid === pickPreferredProviderId(providers))?.provider
      if (!provider) throw new Error("No provider selected")
      const providerId = selectedProviderId || pickPreferredProviderId(providers)
      if (!selectedProviderId && providerId) setSelectedProviderId(providerId)

      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[]
      const account = accounts?.[0]
      if (!account) throw new Error("No account returned by wallet")
      let chainHex = (await provider.request({ method: "eth_chainId" })) as string
      let chainId = Number.parseInt(chainHex, 16)
      if (!Number.isFinite(chainId)) {
        throw new Error(`Wallet returned invalid chain id: ${chainHex}`)
      }

      const supportedChainIds = new Set(Object.values(state?.chains ?? {}).map((c) => c.chainId))
      if (supportedChainIds.size > 0 && !supportedChainIds.has(chainId)) {
        const fallbackChain =
          chainOptions.find((c) => c.chainId === selectedSourceChainId) ??
          chainOptions[0]
        if (!fallbackChain) {
          throw new Error(`Unsupported chainId ${chainId}; no supported fallback chain configured.`)
        }
        appendLog(
          `Wallet is on unsupported chain ${chainId}. Switching to supported chain ${fallbackChain.name} (${fallbackChain.chainId}).`
        )
        await ensureChain(provider, fallbackChain.chainIdHex)
        chainHex = (await provider.request({ method: "eth_chainId" })) as string
        chainId = Number.parseInt(chainHex, 16)
      }

      await api("/session/wallet", "POST", {
        account,
        chainId,
        providerId,
        providerName: providers.find((p) => p.info.uuid === providerId)?.info.name,
      })
      setWalletAddress(account)
      setWalletChainHex(chainHex)
      setSelectedSourceChainId(chainId)
      appendLog(`Wallet connected ${account} on ${chainHex}`)
      setNotice({ type: "success", message: `Wallet connected: ${shortAddr(account)}` })
      await loadSessionState()
    } catch (err) {
      const message = formatRpcError(err)
      appendLog(`Wallet connection failed: ${message}`)
      const lower = message.toLowerCase()
      let friendly = "Wallet connection failed. Check MetaMask and retry."
      if (lower.includes("session expired")) {
        friendly = "Session expired. Click Start Session, then reconnect wallet."
      } else if (lower.includes("session not found")) {
        friendly =
          "CLI bridge session was not found on this bridge server. Restart CLI and open the new signer URL from CLI output."
      } else if (lower.includes("missing sessionid/token") || lower.includes("invalid session token")) {
        friendly = "Session token is invalid. Start a new session and reconnect."
      } else if (lower.includes("no injected wallet provider")) {
        friendly = "MetaMask provider not detected. Unlock MetaMask and refresh."
      } else if (lower.includes("user rejected") || lower.includes("4001")) {
        friendly = "Connection was rejected in MetaMask."
      } else if (lower.includes("unsupported chainid")) {
        friendly = "Wallet is on an unsupported chain. Switch MetaMask to Sepolia/Amoy/Arbitrum Sepolia/Base Sepolia/Fuji and retry."
      }
      setNotice({ type: "error", message: friendly })
    } finally {
      setBusy(false)
    }
  }

  async function ensureChain(provider: Eip1193Provider, chainIdHex: `0x${string}`) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }],
      })
      return
    } catch (err: any) {
      if (err?.code !== 4902) throw err
      const chain = Object.values(state?.chains ?? {}).find((c) => c.chainIdHex.toLowerCase() === chainIdHex.toLowerCase())
      if (!chain) throw new Error(`Chain config not found for ${chainIdHex}`)
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chain.chainIdHex,
            chainName: chain.name,
            rpcUrls: [chain.rpcUrl],
            nativeCurrency: chain.nativeCurrency,
            blockExplorerUrls: [chain.blockExplorer],
          },
        ],
      })
    }
  }

  async function syncWalletChainIfNeeded() {
    if (!selectedProvider || !walletAddress) return
    const src = chainOptions.find((c) => c.chainId === selectedSourceChainId)
    if (!src) return
    await ensureChain(selectedProvider, src.chainIdHex)
    await api("/session/wallet", "POST", {
      account: walletAddress,
      chainId: src.chainId,
      providerId: selectedProviderId,
    })
    setWalletChainHex(src.chainIdHex)
  }

  async function setConfidentialMode(enabled: boolean) {
    if (!sessionId || !token) return
    setBusy(true)
    try {
      await api("/session/confidential-mode", "POST", { enabled })
      await loadSessionState()
      setNotice({
        type: "success",
        message: enabled ? "Confidential transactions activated." : "Confidential transactions deactivated.",
      })
      appendLog(
        enabled
          ? "Confidential mode toggled ON for this session."
          : "Confidential mode toggled OFF for this session."
      )
    } catch (err) {
      setNotice({ type: "error", message: "Failed to update confidential mode." })
      appendLog(`Failed to update confidential mode: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function submitConfidentialTransfer(
    intent: PreparedIntentBundle,
    provider: Eip1193Provider,
    sender: string,
    confidential: ConfidentialMode
  ): Promise<{ privateTransferId: string }> {
    const recipient = String(intent.params.recipient ?? "")
    const tokenAddress = String(intent.params.token ?? "")
    const amount =
      typeof intent.params.amountWei === "string" && intent.params.amountWei.length > 0
        ? intent.params.amountWei
        : String(intent.params.amount ?? "")

    if (!recipient || !tokenAddress || !amount) {
      throw new Error("Confidential transfer requires recipient, token, and amount in intent params.")
    }
    if (!isAddressLike(recipient)) {
      throw new Error(`Invalid recipient address in intent params: ${recipient}`)
    }
    if (!isAddressLike(tokenAddress)) {
      throw new Error(`Invalid token address in intent params: ${tokenAddress}`)
    }

    const providerAccounts = (await provider.request({ method: "eth_accounts" })) as unknown
    const connectedAccounts = Array.isArray(providerAccounts) ? providerAccounts.map((v) => String(v)) : []
    const signerAddress = connectedAccounts[0] ?? sender
    if (!signerAddress || !isAddressLike(signerAddress)) {
      throw new Error(`Invalid signer address from wallet: ${String(signerAddress)}`)
    }

    const timestamp = Math.floor(Date.now() / 1000)
    const flags = confidential.hideSenderDefault ? ["hide-sender"] : []
    const flagsCsv = flags.join(",")
    const walletChainHex = (await provider.request({ method: "eth_chainId" })) as string
    const walletChainId = Number.parseInt(walletChainHex, 16)
    if (!Number.isFinite(walletChainId) || walletChainId <= 0) {
      throw new Error(`Wallet returned invalid chain id: ${walletChainHex}`)
    }

    const configuredDomainChainId = Number(confidential.eip712Domain.chainId)
    if (
      Number.isFinite(configuredDomainChainId) &&
      configuredDomainChainId > 0 &&
      configuredDomainChainId !== walletChainId
    ) {
      appendLog(
        `Confidential domain chainId (${configuredDomainChainId}) differs from wallet chain (${walletChainId}); using wallet chain for signing.`
      )
    }
    const domainChainId = walletChainId
    const verifyingContract = String(confidential.eip712Domain.verifyingContract)
    if (!isAddressLike(verifyingContract)) {
      throw new Error(`Invalid confidential verifyingContract: ${verifyingContract}`)
    }
    const domain = {
      ...confidential.eip712Domain,
      chainId: domainChainId,
      verifyingContract: verifyingContract as `0x${string}`,
    }
    const typedDataVariants: Array<{
      label: string
      primaryType: string
      payload: Record<string, unknown>
    }> = [
      {
        // As documented by convergence2026-token-api docs.
        label: "docs-primary-space_flags-array",
        primaryType: "Private Token Transfer",
        payload: {
          domain,
          primaryType: "Private Token Transfer",
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ["Private Token Transfer"]: [
              { name: "sender", type: "address" },
              { name: "recipient", type: "address" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "flags", type: "string[]" },
              { name: "timestamp", type: "uint256" },
            ],
          },
          message: {
            sender: signerAddress,
            recipient,
            token: tokenAddress,
            amount,
            flags,
            timestamp,
          },
        },
      },
      {
        label: "identifier-primary_flags-array",
        primaryType: "PrivateTokenTransfer",
        payload: {
          domain,
          primaryType: "PrivateTokenTransfer",
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            PrivateTokenTransfer: [
              { name: "sender", type: "address" },
              { name: "recipient", type: "address" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "flags", type: "string[]" },
              { name: "timestamp", type: "uint256" },
            ],
          },
          message: {
            sender: signerAddress,
            recipient,
            token: tokenAddress,
            amount,
            flags,
            timestamp,
          },
        },
      },
      {
        label: "identifier-primary_flags-string",
        primaryType: "PrivateTokenTransfer",
        payload: {
          domain,
          primaryType: "PrivateTokenTransfer",
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            PrivateTokenTransfer: [
              { name: "sender", type: "address" },
              { name: "recipient", type: "address" },
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
              { name: "flags", type: "string" },
              { name: "timestamp", type: "uint256" },
            ],
          },
          message: {
            sender: signerAddress,
            recipient,
            token: tokenAddress,
            amount,
            flags: flagsCsv,
            timestamp,
          },
        },
      },
    ]

    let signature = ""
    let authPayload: Record<string, unknown> = {}
    const signErrors: string[] = []
    for (const variant of typedDataVariants) {
      const typedData = variant.payload
      const typedDataJson = JSON.stringify(typedData)
      const signingAttempts: Array<{ method: string; params: unknown[]; label: string }> = [
        { method: "eth_signTypedData_v4", params: [signerAddress, typedDataJson], label: "addr,json" },
        { method: "eth_signTypedData_v4", params: [typedDataJson, signerAddress], label: "json,addr" },
        { method: "eth_signTypedData_v4", params: [signerAddress, typedData], label: "addr,obj" },
        { method: "eth_signTypedData_v3", params: [signerAddress, typedDataJson], label: "addr,json" },
        { method: "eth_signTypedData_v3", params: [typedDataJson, signerAddress], label: "json,addr" },
        { method: "eth_signTypedData", params: [signerAddress, typedData], label: "addr,obj" },
        { method: "eth_signTypedData", params: [typedData, signerAddress], label: "obj,addr" },
        { method: "eth_signTypedData", params: [signerAddress, typedDataJson], label: "addr,json" },
        { method: "eth_signTypedData", params: [typedDataJson, signerAddress], label: "json,addr" },
      ]
      for (const attempt of signingAttempts) {
        try {
          signature = (await provider.request({
            method: attempt.method,
            params: attempt.params,
          })) as string
          if (signature) {
            authPayload = {
              type: "eip712",
              signature,
              primaryType: variant.primaryType,
              domain,
              variant: variant.label,
              method: attempt.method,
              order: attempt.label,
            }
            appendLog(`Confidential signing succeeded via ${attempt.method} (${attempt.label}) using ${variant.label}.`)
            break
          }
        } catch (err) {
          signErrors.push(`${variant.label}:${attempt.method}[${attempt.label}]: ${formatRpcError(err)}`)
        }
      }
      if (signature) break
    }

    if (!signature) {
      const message = JSON.stringify({
        sender: signerAddress,
        recipient,
        token: tokenAddress,
        amount,
        flags,
        timestamp,
      })
      const hexMessage = utf8ToHex(message)
      const personalAttempts: Array<{ method: string; params: unknown[] }> = [
        { method: "personal_sign", params: [hexMessage, signerAddress] },
        { method: "personal_sign", params: [signerAddress, hexMessage] },
      ]
      for (const attempt of personalAttempts) {
        try {
          signature = (await provider.request({
            method: attempt.method,
            params: attempt.params,
          })) as string
          if (signature) {
            authPayload = {
              type: "personal_sign",
              signature,
              message: hexMessage,
            }
            appendLog("Typed-data signing unsupported; used personal_sign fallback.")
            break
          }
        } catch (err) {
          signErrors.push(`${attempt.method}: ${formatRpcError(err)}`)
        }
      }
    }

    if (!signature) {
      throw new Error(`Typed-data signing failed. ${signErrors.join(" | ")}`)
    }

    const base = confidential.tokenApiBaseUrl.replace(/\/+$/, "")
    const response = await fetch(`${base}/private-transfer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        account: signerAddress,
        sender: signerAddress,
        recipient,
        token: tokenAddress,
        amount,
        flags,
        timestamp,
        auth: signature,
        signature,
        auth_meta: authPayload,
      }),
    })

    const json = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      const detail = json.error ?? json.message ?? json
      throw new Error(`Confidential API HTTP ${response.status}: ${formatUnknown(detail)}`)
    }

    const privateTransferId = String(
      json.transaction_id ?? json.transactionId ?? json.id ?? json.requestId ?? json.txHash ?? ""
    )
    if (!privateTransferId) {
      throw new Error("Confidential transfer succeeded but no transaction id was returned.")
    }

    return { privateTransferId }
  }

  async function waitForReceipt(provider: Eip1193Provider, txHash: string): Promise<boolean> {
    for (let i = 0; i < 180; i++) {
      const receipt = (await provider.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      })) as null | { status?: string }
      if (receipt) return receipt.status === "0x1"
      await sleep(2000)
    }
    return false
  }

  async function buildIntent(serviceType: ServiceType, action: ServiceAction, params: Record<string, unknown>) {
    if (!serviceAllowedOnSelectedChain(action)) {
      appendLog(`Action ${action} is not enabled for source chain ${selectedSourceChainId}`)
      return
    }
    if (sourceTokens.length === 0 && action !== "CHAINALERT_UPSERT_RULE") {
      appendLog(`No token preset configured for source chain ${selectedSourceChainId}`)
      return
    }

    setBusy(true)
    try {
      await syncWalletChainIfNeeded()
      const out = await api("/intents/build", "POST", {
        nonce: randomNonce(),
        serviceType,
        action,
        params: {
          sourceChainId: selectedSourceChainId,
          ...params,
        },
      })
      appendLog(`Intent created: ${String((out as any).intentId ?? "")}`)
      await loadSessionState()
    } catch (err) {
      appendLog(`Intent build failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  async function signIntent(intent: PreparedIntentBundle) {
    if (!selectedProvider) throw new Error("No provider selected")
    if (!walletAddress) throw new Error("Connect wallet first")
    setBusy(true)
    try {
      const confidentialMode = state?.confidentialMode
      const currentModeEnabled = Boolean(confidentialMode?.enabled)
      if (currentModeEnabled !== intent.builtWithConfidentialMode.enabled) {
        appendLog(
          `Mode mismatch for ${shortAddr(intent.intentId)} (built=${intent.builtWithConfidentialMode.enabled ? "ON" : "OFF"}, current=${currentModeEnabled ? "ON" : "OFF"}). Rebuild to switch mode for this intent.`
        )
      }

      if (confidentialMode?.enabled && confidentialMode.strict && !supportsConfidentialTransfer(intent.action)) {
        throw new Error(`Confidential strict mode blocks non-confidential action: ${intent.action}`)
      }

      if (confidentialMode?.enabled && isPublicOnChainAction(intent.action)) {
        const accepted = window.confirm(
          "Confidential Mode is active, but this action is public on-chain and explorer-visible. Continue?"
        )
        if (!accepted) {
          appendLog(`User cancelled public on-chain action while confidential mode is active.`)
          return
        }
      }

      if (intent.executionMode === "CONFIDENTIAL_PRIVATE") {
        if (!supportsConfidentialTransfer(intent.action)) {
          throw new Error(`Intent is marked confidential but action is unsupported: ${intent.action}`)
        }
        if (!confidentialMode) {
          throw new Error("Confidential mode settings are unavailable from session state.")
        }
        const confidentialSubmission = await submitConfidentialTransfer(
          intent,
          selectedProvider,
          walletAddress,
          {
            ...confidentialMode,
            enabled: intent.builtWithConfidentialMode.enabled,
            strict: intent.builtWithConfidentialMode.strict,
            provider: intent.builtWithConfidentialMode.provider,
          }
        )
        await api(`/intents/${intent.intentId}/submit`, "POST", {
          confidentialRef: {
            provider: intent.builtWithConfidentialMode.provider,
            privateTransferId: confidentialSubmission.privateTransferId,
            submittedAt: new Date().toISOString(),
          },
        })
        await api(`/intents/${intent.intentId}/finalize`, "POST", { status: "CONFIRMED" })
        appendLog(
          `Intent ${intent.intentId} confirmed via Confidential Compute. privateTransferId=${confidentialSubmission.privateTransferId}`
        )
        await loadSessionState()
        return
      }

      for (const tx of intent.transactions) {
        await ensureChain(selectedProvider, tx.chainIdHex)
        const txHash = (await selectedProvider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: walletAddress,
              to: tx.to,
              data: tx.data,
              value: tx.value,
            },
          ],
        })) as string

        await api(`/intents/${intent.intentId}/submit`, "POST", { txHash })
        const ok = await waitForReceipt(selectedProvider, txHash)
        if (!ok) {
          await api(`/intents/${intent.intentId}/finalize`, "POST", {
            status: "FAILED",
            error: `Transaction reverted or dropped: ${txHash}`,
          })
          appendLog(`Intent ${intent.intentId} failed at tx ${txHash}`)
          await loadSessionState()
          return
        }
      }
      await api(`/intents/${intent.intentId}/finalize`, "POST", { status: "CONFIRMED" })
      appendLog(`Intent ${intent.intentId} confirmed`)
      await loadSessionState()
    } catch (err) {
      const errText = formatRpcError(err)
      await api(`/intents/${intent.intentId}/finalize`, "POST", {
        status: "FAILED",
        error: errText,
      }).catch(() => undefined)
      appendLog(`Intent signing failed: ${errText}`)
    } finally {
      setBusy(false)
    }
  }

  async function startSession() {
    if (isCliLinkedSession) {
      appendLog("Session is managed by CLI URL. Start Session is disabled for linked mode.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${bridgeBaseUrl}/session/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const json = (await res.json()) as any
      if (!res.ok) throw new Error(String(json.error ?? "session start failed"))
      setSessionId(json.sessionId)
      setToken(json.token)
      appendLog(`Session started: ${json.sessionId}`)
      if (json.confidentialMode) {
        appendLog(
          `Session confidential mode default: ${json.confidentialMode.enabled ? "ACTIVE" : "INACTIVE"}`
        )
      }
    } catch (err) {
      appendLog(`Session start failed: ${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const selectedTokenByAction = (action: ServiceAction) =>
    selectedTokens[action] || sourceTokens[0]?.address || ""

  const pendingIntents = state?.intents ?? []
  const confidentialActive = Boolean(state?.confidentialMode?.enabled)
  const confidentialPolicyNote = state?.confidentialMode?.strict
    ? "Strict mode: non-confidential actions are blocked."
    : "Policy: DCA and ChainAlert remain public on-chain while confidential mode is active."

  return (
    <div className="page">
      {notice && <div className={`toast ${notice.type}`}>{notice.message}</div>}
      <header className="hero">
        <div className="hero-top">
          <img className="brand-logo" src="/chainlink/chainlink-logo-blue.png" alt="Chainlink" />
          <div className="hero-connect">
            <button
              className={`connect-wallet-btn ${isWalletConnected ? "connected" : ""}`}
              onClick={() => connectWallet()}
              disabled={busy || !sessionId || !token || providers.length === 0}
            >
              {isWalletConnected ? "Connected" : "Connect Wallet"}
            </button>
            <div className="muted hero-wallet-line">
              Address: {shortAddr(walletAddress || state?.walletContext?.account || "-")} | Wallet Chain:{" "}
              {walletChainHex || state?.walletContext?.chainIdHex || "-"}
            </div>
            <div className="muted hero-wallet-line">
              Provider:{" "}
              {providers.length === 0
                ? "Not detected"
                : providers.find((p) => p.info.uuid === selectedProviderId)?.info.name ?? "Detected"}
            </div>
          </div>
        </div>
        <h1>{SYSTEM_NAME}</h1>
        <p className="muted hero-copy">
          {SYSTEM_TAGLINE}
        </p>
      </header>

      {confidentialActive && (
        <section className="confidential-banner">
          <strong>Confidential Mode Active</strong>
          <span>
            Provider: {state?.confidentialMode?.provider.split("_").join(" ")} · {confidentialPolicyNote}
          </span>
        </section>
      )}

      <div className="top-panels">
        <section className="card top-card">
          <h2>Session Link</h2>
          <div className="bridge-stack">
            <label>
              Bridge URL
              <input
                value={bridgeBaseUrl}
                onChange={(e) => setBridgeBaseUrl(e.target.value)}
                disabled={isCliLinkedSession}
              />
            </label>
          </div>
          {isCliLinkedSession && (
            <div className="muted" style={{ marginBottom: 8 }}>
              Linked mode: attached to CLI session {shortAddr(sessionId)}.
            </div>
          )}
          <div className="row">
            <button onClick={startSession} disabled={busy || isCliLinkedSession}>Start Session</button>
            <button onClick={() => loadSessionState()} disabled={busy || !sessionId || !token}>Refresh State</button>
          </div>
        </section>

        <section className="card top-card">
          <h2>Source Defaults</h2>
          <div className="route-stack">
            <label>
              Source Network
              <select
                value={String(selectedSourceChainId)}
                onChange={(e) => setSelectedSourceChainId(Number(e.target.value))}
              >
                {chainOptions.map((c) => (
                  <option key={c.chainId} value={c.chainId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Default Token
              <select
                value={selectedTokenByAction("CHAINSHIELD_TRANSFER")}
                onChange={(e) => {
                  const next = e.target.value
                  setSelectedTokens({
                    DCA_CREATE_TIMED_ORDER: next,
                    CHAINSHIELD_TRANSFER: next,
                    CROSSVAULT_DEPOSIT: next,
                    CHAINALERT_UPSERT_RULE: selectedTokens.CHAINALERT_UPSERT_RULE,
                  })
                }}
              >
                {sourceTokens.length === 0 && <option value="">No tokens configured for this chain</option>}
                {sourceTokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol} - {t.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="card top-card">
          <h2>Privacy Mode</h2>
          <div className="muted" style={{ marginBottom: 10 }}>
            Mode:{" "}
            <strong>{state?.confidentialMode?.enabled ? "ACTIVE" : "INACTIVE"}</strong>
            {state?.confidentialMode && (
              <> · Provider: {state.confidentialMode.provider.split("_").join(" ")}</>
            )}
          </div>
          <div className="muted" style={{ marginBottom: 10 }}>
            {confidentialPolicyNote}
          </div>
          <button
            disabled={busy || !sessionId || !token || !state}
            onClick={() => setConfidentialMode(!(state?.confidentialMode?.enabled ?? false))}
          >
            {state?.confidentialMode?.enabled
              ? "Deactivate Confidential Transactions"
              : "Activate Confidential Transactions"}
          </button>
        </section>
      </div>

      <section className="card">
        <h2>Service Routing</h2>
        <div className="service-grid">
          <div className="service-item">
            <strong>{actionTitle("CHAINSHIELD_TRANSFER")}</strong>
            <div className="muted">Configured from CLI wizard. Sign and submit from Pending Intents.</div>
          </div>
          <div className="service-item">
            <strong>{actionTitle("CROSSVAULT_DEPOSIT")}</strong>
            <div className="muted">Configured from CLI wizard. Sign and submit from Pending Intents.</div>
          </div>
        </div>
        <div className="muted">
          Use CLI for ChainShield and CrossVault parameter entry. Use this page for wallet connection, privacy mode, and
          intent signing.
        </div>
      </section>

      <section className="card">
        <h2>DCA Intent Builder</h2>
        {confidentialActive && <div className="mode-badge public">Public On-Chain</div>}
        <div className="grid">
          <label>
            Destination Network
            <select
              value={dca.destinationChainKey}
              onChange={(e) => setDca({ ...dca, destinationChainKey: e.target.value })}
            >
              {destinationChainOptions.map((k) => <option key={k} value={k}>{state?.chains[k].name ?? k}</option>)}
            </select>
          </label>
          <label>
            Recipient Address
            <input value={dca.recipient} onChange={(e) => setDca({ ...dca, recipient: e.target.value })} />
          </label>
          <label>
            Amount
            <input value={dca.amount} onChange={(e) => setDca({ ...dca, amount: e.target.value })} />
          </label>
          <label>
            Interval Seconds
            <input value={dca.intervalSeconds} onChange={(e) => setDca({ ...dca, intervalSeconds: e.target.value })} />
          </label>
          <label>
            Max Executions
            <input value={dca.maxExecutions} onChange={(e) => setDca({ ...dca, maxExecutions: e.target.value })} />
          </label>
        </div>
        <button
          disabled={busy || !sessionId || !token}
          onClick={() =>
            buildIntent("DCA", "DCA_CREATE_TIMED_ORDER", {
              token: selectedTokenByAction("DCA_CREATE_TIMED_ORDER"),
              amount: dca.amount,
              destinationChainKey: dca.destinationChainKey,
              recipient: dca.recipient,
              action: dca.action,
              intervalSeconds: Number(dca.intervalSeconds),
              maxExecutions: Number(dca.maxExecutions),
              recurring: true,
              deadlineUnix: 0,
            })
          }
        >
          Queue DCA Intent
        </button>
      </section>

      <section className="card">
        <h2>ChainAlert Intent Builder</h2>
        {confidentialActive && <div className="mode-badge public">Public On-Chain</div>}
        <div className="grid">
          <label>
            Rule ID (0=create)
            <input value={alert.ruleId} onChange={(e) => setAlert({ ...alert, ruleId: e.target.value })} />
          </label>
          <label>
            Alert Type (enum 0-13)
            <input value={alert.alertType} onChange={(e) => setAlert({ ...alert, alertType: e.target.value })} />
          </label>
          <label>
            Cooldown Seconds
            <input
              value={alert.cooldownSeconds}
              onChange={(e) => setAlert({ ...alert, cooldownSeconds: e.target.value })}
            />
          </label>
          <label>
            Rearm Seconds
            <input value={alert.rearmSeconds} onChange={(e) => setAlert({ ...alert, rearmSeconds: e.target.value })} />
          </label>
          <label>
            Params JSON
            <textarea value={alert.paramsJson} onChange={(e) => setAlert({ ...alert, paramsJson: e.target.value })} />
          </label>
        </div>
        <button
          disabled={busy || !sessionId || !token}
          onClick={() =>
            buildIntent("CHAINALERT", "CHAINALERT_UPSERT_RULE", {
              ruleId: Number(alert.ruleId),
              alertType: Number(alert.alertType),
              enabled: true,
              cooldownSeconds: Number(alert.cooldownSeconds),
              rearmSeconds: Number(alert.rearmSeconds),
              paramsJson: alert.paramsJson,
            })
          }
        >
          Queue ChainAlert Intent
        </button>
      </section>

      <section className="card">
        <h2>Pending Intents</h2>
        <div className="muted" style={{ marginBottom: 8 }}>
          Review details, then sign and submit each queued intent with MetaMask.
        </div>
        {pendingIntents.length === 0 && <div className="muted">No pending intents.</div>}
        {pendingIntents.map((intent) => {
          const stale = Boolean(
            state &&
              intent.builtWithConfidentialMode.enabled !== state.confidentialMode.enabled
          )
          return (
            <div key={intent.intentId} className="intent">
              <div className="intent-main">
                <div className="intent-head">
                  <strong>{actionTitle(intent.action)}</strong> · {intent.status}
                  <span
                    className={`mode-badge ${intent.executionMode === "CONFIDENTIAL_PRIVATE" ? "private" : "public"}`}
                  >
                    {modeBadgeLabel(intent)}
                  </span>
                </div>
                <div className="muted">
                  {shortAddr(intent.intentId)} · txs: {intent.transactions.length}
                </div>
                <div className="muted">
                  Built under: Confidential {intent.builtWithConfidentialMode.enabled ? "ON" : "OFF"}
                </div>
                {stale && (
                  <div className="stale-note">
                    Rebuild required after mode change (intent keeps build-time mode).
                  </div>
                )}
                {intent.executionMode === "CONFIDENTIAL_PRIVATE" && intent.confidentialRef && (
                  <div className="muted">
                    Confidential transfer ID: <strong>{intent.confidentialRef.privateTransferId}</strong> · No public tx
                    hash path used.
                  </div>
                )}
                {intent.executionMode === "PUBLIC_EVM" && intent.submittedTxHash && (
                  <div className="muted">
                    Submitted tx hash: {shortAddr(intent.submittedTxHash)}
                  </div>
                )}
                <ol className="intent-steps">
                  {intent.transactions.map((tx) => (
                    <li key={tx.txId}>
                      {tx.description}
                      {tx.description.toLowerCase().includes("approve") && (
                        <span className="tx-tag">Approval</span>
                      )}
                      {tx.description.toLowerCase().includes("auto-fund sender link") && (
                        <span className="tx-tag">Auto LINK Top-up</span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
              <button disabled={busy} onClick={() => signIntent(intent)}>Sign & Submit</button>
            </div>
          )
        })}
      </section>

      <section className="card">
        <h2>Activity Log</h2>
        <div className="log-list">
          {logs.map((entry, idx) => (
            <div className="muted log-line" key={`${idx}-${entry}`}>
              {entry}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
