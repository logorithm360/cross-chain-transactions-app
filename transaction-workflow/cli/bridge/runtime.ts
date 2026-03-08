import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes, randomUUID } from "node:crypto"
import { URL } from "node:url"
import {
  BRIDGE_CONFIG,
  CHAINS,
  CONFIDENTIAL_COMPUTE,
  TOKEN_PRESETS_BY_CHAIN_ID,
  SUPPORTED_SOURCE_CHAINS_BY_ACTION,
} from "../config.js"
import { buildTransactions } from "./intentBuilders.js"
import type {
  BridgeEvent,
  BridgeSessionStartResponse,
  BuiltWithConfidentialMode,
  ConfidentialSubmissionRef,
  ConfidentialComputeMode,
  ConfidentialIntentMeta,
  IntentExecutionMode,
  IntentPrivacyOutcome,
  IntentBuildRequest,
  IntentStatus,
  PreparedIntentBundle,
  WalletContext,
} from "../../shared/intents.js"

interface SessionRecord {
  sessionId: string
  token: string
  createdAt: number
  expiresAt: number
  walletContext?: WalletContext
  confidentialMode: ConfidentialComputeMode
  nonceSet: Set<string>
  intentIds: Set<string>
}

type Waiter = (intent: PreparedIntentBundle) => void

const sessions = new Map<string, SessionRecord>()
const intents = new Map<string, PreparedIntentBundle>()
const waiters = new Map<string, Set<Waiter>>()
const sseClients = new Map<string, Set<ServerResponse<IncomingMessage>>>()

let serverStarted = false

const SERIALIZABLE_CHAINS = Object.fromEntries(
  Object.entries(CHAINS).map(([key, value]) => [
    key,
    {
      ...value,
      selector: value.selector.toString(),
    },
  ])
)

function now(): number {
  return Date.now()
}

function iso(ts: number): string {
  return new Date(ts).toISOString()
}

function makeToken(): string {
  return randomBytes(24).toString("hex")
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim()
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function parsePath(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${BRIDGE_CONFIG.host}:${BRIDGE_CONFIG.port}`)
}

function corsHeaders(origin?: string): Record<string, string> {
  const allowed = origin && BRIDGE_CONFIG.allowedOrigins.includes(origin) ? origin : BRIDGE_CONFIG.allowedOrigins[0]
  return {
    "access-control-allow-origin": allowed ?? "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-session-token,x-session-id",
    "access-control-allow-credentials": "true",
  }
}

function resolveSession(req: IncomingMessage, url: URL, body?: Record<string, unknown>): SessionRecord {
  const sessionId =
    (req.headers["x-session-id"] as string | undefined) ??
    (url.searchParams.get("sessionId") ?? undefined) ??
    (typeof body?.sessionId === "string" ? body.sessionId : undefined)
  const token = (req.headers["x-session-token"] as string | undefined) ?? (url.searchParams.get("token") ?? undefined)

  if (!sessionId || !token) {
    throw new Error("Missing sessionId/token")
  }

  const session = sessions.get(sessionId)
  if (!session) throw new Error("Session not found")
  if (session.token !== token) throw new Error("Invalid session token")
  if (session.expiresAt <= now()) throw new Error("Session expired")
  return session
}

function emitEvent(event: BridgeEvent): void {
  const clients = sseClients.get(event.sessionId)
  if (clients) {
    const wire = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    for (const res of clients) {
      res.write(wire)
    }
  }

  if (event.type === "SESSION_CONFIDENTIAL_MODE_UPDATED") {
    const enabled = event.payload?.enabled ? "ON" : "OFF"
    // eslint-disable-next-line no-console
    console.log(`[bridge:event] confidential-mode=${enabled} session=${event.sessionId}`)
    return
  }

  if (event.type.startsWith("INTENT_")) {
    const mode =
      typeof event.payload?.executionMode === "string" ? event.payload.executionMode : "-"
    const intent = event.intentId ? event.intentId.slice(0, 8) : "-"
    // eslint-disable-next-line no-console
    console.log(`[bridge:event] ${event.type} intent=${intent} mode=${mode}`)
  }
}

function buildConfidentialIntentMeta(mode: ConfidentialComputeMode): ConfidentialIntentMeta {
  return {
    enabled: mode.enabled,
    strict: mode.strict,
    provider: mode.provider,
    tokenApiBaseUrl: mode.tokenApiBaseUrl,
    hideSender: mode.hideSenderDefault,
  }
}

function supportsConfidentialTransfer(action: IntentBuildRequest["action"]): boolean {
  return action === "CHAINSHIELD_TRANSFER" || action === "CROSSVAULT_DEPOSIT"
}

function resolveExecutionMetadata(
  mode: ConfidentialComputeMode,
  action: IntentBuildRequest["action"]
): {
  executionMode: IntentExecutionMode
  privacyOutcome: IntentPrivacyOutcome
  builtWithConfidentialMode: BuiltWithConfidentialMode
} {
  const useConfidentialPrivate = mode.enabled && supportsConfidentialTransfer(action)
  return {
    executionMode: useConfidentialPrivate ? "CONFIDENTIAL_PRIVATE" : "PUBLIC_EVM",
    privacyOutcome: useConfidentialPrivate ? "EXPLORER_NOT_APPLICABLE" : "EXPLORER_VISIBLE",
    builtWithConfidentialMode: {
      enabled: mode.enabled,
      strict: mode.strict,
      provider: mode.provider,
    },
  }
}

async function createIntent(session: SessionRecord, request: IntentBuildRequest): Promise<PreparedIntentBundle> {
  if (session.nonceSet.has(request.nonce)) {
    throw new Error(`Replay detected for nonce ${request.nonce}`)
  }
  session.nonceSet.add(request.nonce)

  const createdAt = now()
  const expiresAt = createdAt + BRIDGE_CONFIG.intentTtlSeconds * 1000
  const intentId = randomUUID()
  const mergedRequest: IntentBuildRequest = {
    ...request,
    params: {
      ...(request.params ?? {}),
      __confidential: buildConfidentialIntentMeta(session.confidentialMode),
    },
  }
  const transactions = await buildTransactions(mergedRequest)
  const executionMeta = resolveExecutionMetadata(session.confidentialMode, request.action)

  const intent: PreparedIntentBundle = {
    intentId,
    sessionId: session.sessionId,
    nonce: request.nonce,
    serviceType: request.serviceType,
    action: request.action,
    status: "SIGN_REQUESTED",
    executionMode: executionMeta.executionMode,
    privacyOutcome: executionMeta.privacyOutcome,
    builtWithConfidentialMode: executionMeta.builtWithConfidentialMode,
    createdAt: iso(createdAt),
    expiresAt: iso(expiresAt),
    transactions,
    params: mergedRequest.params,
  }

  intents.set(intentId, intent)
  session.intentIds.add(intentId)

  emitEvent({
    type: "INTENT_CREATED",
    sessionId: session.sessionId,
    intentId,
    payload: {
      serviceType: intent.serviceType,
      action: intent.action,
      status: intent.status,
      executionMode: intent.executionMode,
      privacyOutcome: intent.privacyOutcome,
      builtWithConfidentialMode: intent.builtWithConfidentialMode,
    },
    at: iso(now()),
  })

  return intent
}

function updateIntent(intentId: string, patch: Partial<PreparedIntentBundle>): PreparedIntentBundle {
  const existing = intents.get(intentId)
  if (!existing) throw new Error(`Intent ${intentId} not found`)
  const next: PreparedIntentBundle = { ...existing, ...patch }
  intents.set(intentId, next)
  return next
}

function onIntent(intentId: string, cb: Waiter): () => void {
  if (!waiters.has(intentId)) waiters.set(intentId, new Set())
  waiters.get(intentId)!.add(cb)
  return () => waiters.get(intentId)?.delete(cb)
}

function notifyIntent(intent: PreparedIntentBundle): void {
  const list = waiters.get(intent.intentId)
  if (!list) return
  for (const cb of list) cb(intent)
}

function cleanExpired(): void {
  const ts = now()
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= ts) {
      sessions.delete(sessionId)
      continue
    }
    for (const intentId of session.intentIds) {
      const intent = intents.get(intentId)
      if (!intent) continue
      if (new Date(intent.expiresAt).getTime() <= ts && (intent.status === "CREATED" || intent.status === "SIGN_REQUESTED" || intent.status === "SUBMITTED")) {
        const expired = updateIntent(intentId, { status: "EXPIRED", error: "Intent expired before completion" })
        notifyIntent(expired)
        emitEvent({
          type: "INTENT_EXPIRED",
          sessionId,
          intentId,
          payload: { status: expired.status },
          at: iso(ts),
        })
      }
    }
  }
}

setInterval(cleanExpired, 30_000).unref()

export function startBridgeServer(): void {
  if (serverStarted) return
  const server = createServer(async (req, res) => {
    const url = parsePath(req)
    const origin = req.headers.origin
    const cors = corsHeaders(origin)
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      if (req.method === "POST" && url.pathname === "/session/start") {
        const session = createSession()
        writeJson(res, 200, session)
        return
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const session = resolveSession(req, url)
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
        res.write(`event: READY\ndata: ${JSON.stringify({ sessionId: session.sessionId, at: iso(now()) })}\n\n`)
        if (!sseClients.has(session.sessionId)) sseClients.set(session.sessionId, new Set())
        sseClients.get(session.sessionId)!.add(res)
        req.on("close", () => sseClients.get(session.sessionId)?.delete(res))
        return
      }

      if (req.method === "GET" && url.pathname === "/session/state") {
        const session = resolveSession(req, url)
        const pendingIntents = [...session.intentIds]
          .map((id) => intents.get(id))
          .filter((i): i is PreparedIntentBundle => Boolean(i))
          .filter((i) => i.status === "SIGN_REQUESTED" || i.status === "SUBMITTED")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

        writeJson(res, 200, {
          sessionId: session.sessionId,
          expiresAt: iso(session.expiresAt),
          walletContext: session.walletContext ?? null,
          confidentialMode: session.confidentialMode,
          intents: pendingIntents,
          chains: SERIALIZABLE_CHAINS,
          tokenPresetsByChainId: TOKEN_PRESETS_BY_CHAIN_ID,
          supportedSourceChainsByAction: SUPPORTED_SOURCE_CHAINS_BY_ACTION,
        })
        return
      }

      if (req.method === "POST" && url.pathname === "/session/confidential-mode") {
        const body = await readJson(req)
        const session = resolveSession(req, url, body)
        const enabled = body.enabled
        if (typeof enabled !== "boolean") {
          writeJson(res, 400, { error: "enabled must be boolean" })
          return
        }

        session.confidentialMode = {
          ...session.confidentialMode,
          enabled,
        }

        emitEvent({
          type: "SESSION_CONFIDENTIAL_MODE_UPDATED",
          sessionId: session.sessionId,
          payload: {
            enabled: session.confidentialMode.enabled,
            provider: session.confidentialMode.provider,
            strict: session.confidentialMode.strict,
          },
          at: iso(now()),
        })

        writeJson(res, 200, { ok: true, confidentialMode: session.confidentialMode })
        return
      }

      if (req.method === "POST" && url.pathname === "/session/wallet") {
        const body = await readJson(req)
        const session = resolveSession(req, url, body)
        const account = body.account
        const chainId = body.chainId
        if (typeof account !== "string" || typeof chainId !== "number") {
          writeJson(res, 400, { error: "account and chainId are required" })
          return
        }
        const chain = Object.values(CHAINS).find((c) => c.chainId === chainId)
        if (!chain) {
          writeJson(res, 400, { error: `Unsupported chainId ${chainId}` })
          return
        }
        const walletContext: WalletContext = {
          account: account as `0x${string}`,
          chainId,
          chainIdHex: chain.chainIdHex as `0x${string}`,
          providerId: typeof body.providerId === "string" ? body.providerId : undefined,
          providerName: typeof body.providerName === "string" ? body.providerName : undefined,
        }
        session.walletContext = walletContext
        emitEvent({
          type: "SESSION_WALLET_UPDATED",
          sessionId: session.sessionId,
          payload: walletContext as unknown as Record<string, unknown>,
          at: iso(now()),
        })
        writeJson(res, 200, { ok: true, walletContext })
        return
      }

      if (req.method === "POST" && url.pathname === "/intents/build") {
        const body = await readJson(req)
        const session = resolveSession(req, url, body)
        const request: IntentBuildRequest = {
          sessionId: session.sessionId,
          nonce: typeof body.nonce === "string" ? body.nonce : randomUUID(),
          serviceType: body.serviceType as IntentBuildRequest["serviceType"],
          action: body.action as IntentBuildRequest["action"],
          params: (body.params ?? {}) as Record<string, unknown>,
        }
        const intent = await createIntent(session, request)
        writeJson(res, 200, intent)
        return
      }

      if (req.method === "GET" && url.pathname === "/intents") {
        const session = resolveSession(req, url)
        const status = url.searchParams.get("status")
        const items = [...session.intentIds]
          .map((id) => intents.get(id))
          .filter((i): i is PreparedIntentBundle => Boolean(i))
          .filter((i) => (!status ? true : i.status === status))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        writeJson(res, 200, { intents: items })
        return
      }

      if (req.method === "GET" && url.pathname.startsWith("/intents/")) {
        const session = resolveSession(req, url)
        const intentId = url.pathname.split("/")[2]
        const intent = intents.get(intentId)
        if (!intent || intent.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: "Intent not found" })
          return
        }
        writeJson(res, 200, intent)
        return
      }

      if (req.method === "POST" && /\/intents\/[^/]+\/submit$/.test(url.pathname)) {
        const body = await readJson(req)
        const session = resolveSession(req, url, body)
        const intentId = url.pathname.split("/")[2]
        const intent = intents.get(intentId)
        if (!intent || intent.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: "Intent not found" })
          return
        }
        const txHash = body.txHash
        const rawConfidentialRef = body.confidentialRef

        if (typeof txHash === "string" && txHash.startsWith("0x")) {
          if (intent.executionMode === "CONFIDENTIAL_PRIVATE") {
            writeJson(res, 400, { error: "This intent requires confidentialRef submission, not txHash." })
            return
          }
          const updated = updateIntent(intentId, {
            status: "SUBMITTED",
            submittedTxHash: txHash as `0x${string}`,
            walletContext: session.walletContext,
          })
          notifyIntent(updated)
          emitEvent({
            type: "INTENT_SUBMITTED",
            sessionId: session.sessionId,
            intentId,
            payload: { txHash, executionMode: updated.executionMode },
            at: iso(now()),
          })
          writeJson(res, 200, updated)
          return
        }

        if (rawConfidentialRef && typeof rawConfidentialRef === "object") {
          if (intent.executionMode !== "CONFIDENTIAL_PRIVATE") {
            writeJson(res, 400, { error: "This intent is public and must be submitted with txHash." })
            return
          }
          const provider =
            (rawConfidentialRef as Record<string, unknown>).provider === "CONVERGENCE_2026_TOKEN_API"
              ? "CONVERGENCE_2026_TOKEN_API"
              : undefined
          const privateTransferId = (rawConfidentialRef as Record<string, unknown>).privateTransferId
          const submittedAt = (rawConfidentialRef as Record<string, unknown>).submittedAt

          if (!provider || typeof privateTransferId !== "string" || privateTransferId.length === 0) {
            writeJson(res, 400, { error: "confidentialRef.provider and confidentialRef.privateTransferId are required" })
            return
          }

          const confidentialRef: ConfidentialSubmissionRef = {
            provider,
            privateTransferId,
            submittedAt: typeof submittedAt === "string" && submittedAt.length > 0 ? submittedAt : iso(now()),
          }

          const updated = updateIntent(intentId, {
            status: "SUBMITTED",
            confidentialRef,
            submittedTxHash: undefined,
            walletContext: session.walletContext,
          })
          notifyIntent(updated)
          emitEvent({
            type: "INTENT_CONFIDENTIAL_SUBMITTED",
            sessionId: session.sessionId,
            intentId,
            payload: {
              executionMode: updated.executionMode,
              privacyOutcome: updated.privacyOutcome,
              confidentialRef,
            },
            at: iso(now()),
          })
          writeJson(res, 200, updated)
          return
        }

        writeJson(res, 400, { error: "Provide txHash or confidentialRef payload" })
        return
      }

      if (req.method === "POST" && /\/intents\/[^/]+\/finalize$/.test(url.pathname)) {
        const body = await readJson(req)
        const session = resolveSession(req, url, body)
        const intentId = url.pathname.split("/")[2]
        const intent = intents.get(intentId)
        if (!intent || intent.sessionId !== session.sessionId) {
          writeJson(res, 404, { error: "Intent not found" })
          return
        }

        const status = body.status as IntentStatus
        if (status !== "CONFIRMED" && status !== "FAILED") {
          writeJson(res, 400, { error: "status must be CONFIRMED or FAILED" })
          return
        }
        const updated = updateIntent(intentId, {
          status,
          error: typeof body.error === "string" ? body.error : undefined,
        })
        notifyIntent(updated)
        const type =
          status === "CONFIRMED"
            ? updated.executionMode === "CONFIDENTIAL_PRIVATE"
              ? "INTENT_CONFIDENTIAL_CONFIRMED"
              : "INTENT_CONFIRMED"
            : updated.executionMode === "CONFIDENTIAL_PRIVATE"
              ? "INTENT_CONFIDENTIAL_FAILED"
              : "INTENT_FAILED"

        emitEvent({
          type,
          sessionId: session.sessionId,
          intentId,
          payload: {
            status,
            error: updated.error,
            executionMode: updated.executionMode,
            privacyOutcome: updated.privacyOutcome,
            confidentialRef: updated.confidentialRef,
            txHash: updated.submittedTxHash,
          },
          at: iso(now()),
        })
        writeJson(res, 200, updated)
        return
      }

      writeJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeJson(res, 400, { error: message })
    }
  })

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(
        `[bridge] port ${BRIDGE_CONFIG.port} is already in use. ` +
          `Another bridge process is likely running, which will break this CLI session mapping. ` +
          `Stop the other process or set ORCHESTRATOR_BRIDGE_PORT to a free port, then restart CLI.`
      )
      process.exit(1)
      return
    }
    // eslint-disable-next-line no-console
    console.error(`[bridge] server error: ${err.message}`)
  })

  server.listen(BRIDGE_CONFIG.port, BRIDGE_CONFIG.host, () => {
    // eslint-disable-next-line no-console
    console.log(`[bridge] listening on http://${BRIDGE_CONFIG.host}:${BRIDGE_CONFIG.port}`)
  })

  serverStarted = true
}

export function createSession(): BridgeSessionStartResponse {
  const sessionId = randomUUID()
  const token = makeToken()
  const createdAt = now()
  const expiresAt = createdAt + BRIDGE_CONFIG.sessionTtlSeconds * 1000
  const session: SessionRecord = {
    sessionId,
    token,
    createdAt,
    expiresAt,
    confidentialMode: {
      enabled: CONFIDENTIAL_COMPUTE.enabledByDefault,
      strict: CONFIDENTIAL_COMPUTE.strict,
      provider: CONFIDENTIAL_COMPUTE.provider,
      tokenApiBaseUrl: CONFIDENTIAL_COMPUTE.tokenApiBaseUrl,
      hideSenderDefault: CONFIDENTIAL_COMPUTE.hideSenderDefault,
      eip712Domain: CONFIDENTIAL_COMPUTE.eip712Domain,
    },
    nonceSet: new Set(),
    intentIds: new Set(),
  }
  sessions.set(sessionId, session)
  emitEvent({
    type: "SESSION_CREATED",
    sessionId,
    payload: { expiresAt: iso(expiresAt) },
    at: iso(now()),
  })
  return {
    sessionId,
    token,
    expiresAt: iso(expiresAt),
    baseUrl: `http://${BRIDGE_CONFIG.host}:${BRIDGE_CONFIG.port}`,
    signerUrlHint: `http://127.0.0.1:5173/?sessionId=${sessionId}&token=${token}&bridge=${encodeURIComponent(`http://${BRIDGE_CONFIG.host}:${BRIDGE_CONFIG.port}`)}`,
    confidentialMode: session.confidentialMode,
  }
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return sessions.get(sessionId)
}

export function getSessionWallet(sessionId: string): WalletContext | undefined {
  return sessions.get(sessionId)?.walletContext
}

export async function createIntentForSession(
  sessionId: string,
  req: Omit<IntentBuildRequest, "sessionId">
): Promise<PreparedIntentBundle> {
  const session = sessions.get(sessionId)
  if (!session) throw new Error("Session not found")
  if (session.expiresAt <= now()) throw new Error("Session expired")
  return createIntent(session, { ...req, sessionId })
}

export function waitForIntentTerminal(intentId: string, timeoutMs: number): Promise<PreparedIntentBundle> {
  const current = intents.get(intentId)
  if (!current) throw new Error(`Intent not found: ${intentId}`)
  if (current.status === "CONFIRMED" || current.status === "FAILED" || current.status === "EXPIRED") {
    return Promise.resolve(current)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      reject(new Error(`Timed out waiting for intent ${intentId}`))
    }, timeoutMs)

    const off = onIntent(intentId, (intent) => {
      if (intent.status === "CONFIRMED" || intent.status === "FAILED" || intent.status === "EXPIRED") {
        clearTimeout(timer)
        off()
        resolve(intent)
      }
    })
  })
}

export function subscribeIntentUpdates(
  intentId: string,
  cb: (intent: PreparedIntentBundle) => void
): () => void {
  const current = intents.get(intentId)
  if (!current) throw new Error(`Intent not found: ${intentId}`)
  cb(current)
  return onIntent(intentId, cb)
}
