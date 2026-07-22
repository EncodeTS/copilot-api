import { setTimeout as delay } from "node:timers/promises"
import { WebSocket } from "undici"

import type { ResponsesWebSocketResourceLimits } from "~/lib/responses-websocket-limits"
import {
  resolveUpstreamLifecycleTimeouts,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import {
  isPooledWebSocketIdentity,
  type PooledWebSocketIdentity,
  type ResponsesWebSocketCapacityKey,
  type ResponsesWebSocketPoolKey,
} from "~/services/responses-websocket-identity"
import {
  closeResponsesWebSocket,
  toResponsesWebSocketAbortError,
} from "~/services/responses-websocket-runtime"

type ManagedWebSocket = InstanceType<typeof WebSocket>

interface PooledWebSocketEntry {
  closed: boolean
  closeLogged: boolean
  createdAt: number
  identity: PooledWebSocketIdentity
  idleOrder: number
  idleTimer: ReturnType<typeof setTimeout> | null
  lastReused: boolean
  onClose: (diagnostic: WebSocketCloseDiagnostic) => void
  pooled: boolean
  requestCount: number
  websocket: ManagedWebSocket
  websocketPromise: Promise<ManagedWebSocket>
}

interface PooledWebSocketRequestTarget {
  entry: PooledWebSocketEntry
  pooled: boolean
  reused: boolean
}

export interface OpeningWebSocket {
  websocket: ManagedWebSocket
  websocketPromise: Promise<ManagedWebSocket>
}

export interface WebSocketCloseDiagnostic {
  closeCode: number | null
  closeReason: "none" | "provided"
  connectionAgeMs: number
  pooled: boolean
  readyState: number
  reused: boolean
  wasClean: boolean | null
}

export interface WebSocketConnectionRegistryDiagnostics {
  activeRequests: number
  connections: number
  dedicatedConnections: number
  idleConnections: number
  poolHits: number
  poolMisses: number
  pooledConnections: number
}

export interface AcquirePooledWebSocketOptions {
  identity: PooledWebSocketIdentity
  limits: ResponsesWebSocketResourceLimits
  onClose: (diagnostic: WebSocketCloseDiagnostic) => void
  open: (connectTimeoutMs: number) => OpeningWebSocket
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
}

export interface PooledWebSocketLease {
  connectionAgeMs: () => number
  pooled: boolean
  ready: (unavailableErrorMessage?: string) => Promise<ManagedWebSocket>
  release: () => void
  retire: () => void
  reused: boolean
}

export class WebSocketConnectionCapacityError extends Error {
  constructor() {
    super("Responses websocket connection capacity is exhausted")
    this.name = "WebSocketConnectionCapacityError"
  }
}

const websocketPool = new Map<ResponsesWebSocketPoolKey, PooledWebSocketEntry>()
const websocketEntries = new Set<PooledWebSocketEntry>()
const websocketConnectionsByCapacityKey = new Map<
  ResponsesWebSocketCapacityKey,
  number
>()
const websocketActiveRequests = new Map<ResponsesWebSocketPoolKey, number>()
const capacityWaiters = new Set<() => void>()
let idleOrder = 0
let poolHits = 0
let poolMisses = 0

export const getWebSocketConnectionRegistryDiagnostics =
  (): WebSocketConnectionRegistryDiagnostics => {
    let dedicatedConnections = 0
    let idleConnections = 0
    let pooledConnections = 0
    for (const entry of websocketEntries) {
      if (entry.pooled) {
        pooledConnections += 1
        if (isIdlePooledEntry(entry)) {
          idleConnections += 1
        }
      } else {
        dedicatedConnections += 1
      }
    }

    return {
      activeRequests: sumMapValues(websocketActiveRequests),
      connections: websocketEntries.size,
      dedicatedConnections,
      idleConnections,
      poolHits,
      poolMisses,
      pooledConnections,
    }
  }

export const clearPooledWebSocketRegistry = (): number => {
  const entries = [...new Set(websocketPool.values())]
  for (const entry of entries) {
    retirePooledWebSocketEntry(entry)
  }
  return entries.length
}

export const acquirePooledWebSocketConnection = async (
  options: AcquirePooledWebSocketOptions,
): Promise<PooledWebSocketLease> => {
  if (!isPooledWebSocketIdentity(options.identity)) {
    throw new TypeError(
      "Responses websocket requests require a canonical pooled identity",
    )
  }
  const timeouts = resolveUpstreamLifecycleTimeouts(options.timeouts)
  const startedAt = Date.now()
  const waitMs = Math.min(
    options.limits.capacityWaitMs,
    Math.max(0, timeouts.websocketConnectMs - 1),
  )
  const deadline = startedAt + waitMs

  while (true) {
    if (options.signal?.aborted) {
      throw toResponsesWebSocketAbortError(options.signal.reason)
    }
    const target = tryAcquirePooledWebSocketConnection(
      options,
      Math.max(1, timeouts.websocketConnectMs - (Date.now() - startedAt)),
    )
    if (target) {
      return createPooledWebSocketLease(target, options.limits)
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      throw new WebSocketConnectionCapacityError()
    }
    await waitForWebSocketCapacityChange(remainingMs, options.signal)
  }
}

const tryAcquirePooledWebSocketConnection = (
  options: AcquirePooledWebSocketOptions,
  connectTimeoutMs: number,
): PooledWebSocketRequestTarget | null => {
  const { capacityKey, poolKey } = options.identity
  const existing = websocketPool.get(poolKey)
  if (existing?.closed) {
    retirePooledWebSocketEntry(existing)
  }

  if (getPooledWebSocketActiveRequestCount(poolKey) === 0) {
    const reusable = websocketPool.get(poolKey)
    if (reusable && !reusable.closed) {
      poolHits += 1
      clearPooledWebSocketIdleTimer(reusable)
      acquireEntry(reusable, true)
      return { entry: reusable, pooled: true, reused: true }
    }
  }

  const dedicated = getPooledWebSocketActiveRequestCount(poolKey) > 0
  evictIdleConnectionsForAdmission(capacityKey, dedicated, options.limits)
  if (!hasConnectionCapacity(capacityKey, dedicated, options.limits)) {
    return null
  }

  poolMisses += 1
  const entry = createPooledWebSocketEntry(
    options,
    !dedicated,
    connectTimeoutMs,
  )
  if (!dedicated) {
    websocketPool.set(poolKey, entry)
  }
  acquireEntry(entry, false)
  return { entry, pooled: !dedicated, reused: false }
}

const createPooledWebSocketEntry = (
  options: AcquirePooledWebSocketOptions,
  pooled: boolean,
  connectTimeoutMs: number,
): PooledWebSocketEntry => {
  const { websocket, websocketPromise } = options.open(connectTimeoutMs)
  const entry: PooledWebSocketEntry = {
    closed: false,
    closeLogged: false,
    createdAt: Date.now(),
    identity: options.identity,
    idleOrder: 0,
    idleTimer: null,
    lastReused: false,
    onClose: options.onClose,
    pooled,
    requestCount: 0,
    websocket,
    websocketPromise,
  }
  websocketEntries.add(entry)
  incrementCapacityKeyConnectionCount(entry.identity.capacityKey)
  websocket.addEventListener("close", (event) => {
    logWebSocketClose(entry, event as WebSocketCloseEvent)
    retirePooledWebSocketEntry(entry)
  })
  websocket.addEventListener("error", () => {
    retirePooledWebSocketEntry(entry)
  })
  websocketPromise.catch(() => {
    retirePooledWebSocketEntry(entry)
  })
  return entry
}

const acquireEntry = (entry: PooledWebSocketEntry, reused: boolean): void => {
  clearPooledWebSocketIdleTimer(entry)
  entry.lastReused = reused
  incrementPooledWebSocketActiveRequestCount(entry.identity.poolKey)
  entry.requestCount += 1
}

const createPooledWebSocketLease = (
  target: PooledWebSocketRequestTarget,
  limits: ResponsesWebSocketResourceLimits,
): PooledWebSocketLease => {
  const { entry, pooled, reused } = target
  let released = false
  return {
    connectionAgeMs: () => Math.max(0, Date.now() - entry.createdAt),
    pooled,
    ready: (unavailableErrorMessage) =>
      getReadyPooledWebSocket(entry, pooled, reused, unavailableErrorMessage),
    release: () => {
      if (released) {
        return
      }
      released = true
      entry.requestCount -= 1
      decrementPooledWebSocketActiveRequestCount(entry.identity.poolKey)
      if (entry.closed || entry.requestCount > 0) {
        notifyCapacityChanged()
        return
      }
      if (pooled && websocketPool.get(entry.identity.poolKey) === entry) {
        markPooledWebSocketIdle(entry, limits)
        notifyCapacityChanged()
        return
      }
      retirePooledWebSocketEntry(entry)
    },
    retire: () => retirePooledWebSocketEntry(entry),
    reused,
  }
}

const getReadyPooledWebSocket = async (
  entry: PooledWebSocketEntry,
  pooled: boolean,
  reused: boolean,
  unavailableErrorMessage = "Websocket connection became unavailable before the request started",
): Promise<ManagedWebSocket> => {
  if (entry.closed) {
    throw new Error(unavailableErrorMessage)
  }
  const websocket = await entry.websocketPromise
  if (reused) {
    await delay(0)
  }
  if (
    entry.closed
    || (pooled && websocketPool.get(entry.identity.poolKey) !== entry)
  ) {
    throw new Error(unavailableErrorMessage)
  }
  if (websocket.readyState !== WebSocket.OPEN) {
    retirePooledWebSocketEntry(entry)
    throw new Error(unavailableErrorMessage)
  }
  return websocket
}

const hasConnectionCapacity = (
  capacityKey: ResponsesWebSocketCapacityKey,
  dedicated: boolean,
  limits: ResponsesWebSocketResourceLimits,
): boolean =>
  websocketEntries.size < limits.globalConnectionLimit
  && getCapacityKeyConnectionCount(capacityKey)
    < limits.perCapacityKeyConnectionLimit
  && (!dedicated
    || getDedicatedConnectionCount() < limits.dedicatedConnectionLimit)

const evictIdleConnectionsForAdmission = (
  capacityKey: ResponsesWebSocketCapacityKey,
  dedicated: boolean,
  limits: ResponsesWebSocketResourceLimits,
): void => {
  if (
    dedicated
    && getDedicatedConnectionCount() >= limits.dedicatedConnectionLimit
  ) {
    return
  }
  if (
    websocketEntries.size >= limits.globalConnectionLimit
    || getCapacityKeyConnectionCount(capacityKey)
      >= limits.perCapacityKeyConnectionLimit
  ) {
    const needsCapacityKeyEviction =
      getCapacityKeyConnectionCount(capacityKey)
      >= limits.perCapacityKeyConnectionLimit
    const candidate = findLeastRecentIdleEntry(
      needsCapacityKeyEviction ? capacityKey : undefined,
    )
    if (candidate) {
      retirePooledWebSocketEntry(candidate)
    }
  }
}

const markPooledWebSocketIdle = (
  entry: PooledWebSocketEntry,
  limits: ResponsesWebSocketResourceLimits,
): void => {
  entry.idleOrder = ++idleOrder
  clearPooledWebSocketIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    retirePooledWebSocketEntry(entry)
  }, limits.idleTimeoutMs)
  entry.idleTimer.unref?.()

  while (getIdleConnectionCount() > limits.idleConnectionLimit) {
    const candidate = findLeastRecentIdleEntry()
    if (!candidate) {
      break
    }
    retirePooledWebSocketEntry(candidate)
  }
}

const findLeastRecentIdleEntry = (
  capacityKey?: ResponsesWebSocketCapacityKey,
): PooledWebSocketEntry | undefined => {
  let candidate: PooledWebSocketEntry | undefined
  for (const entry of websocketEntries) {
    if (
      !isIdlePooledEntry(entry)
      || (capacityKey !== undefined
        && entry.identity.capacityKey !== capacityKey)
    ) {
      continue
    }
    if (!candidate || entry.idleOrder < candidate.idleOrder) {
      candidate = entry
    }
  }
  return candidate
}

const isIdlePooledEntry = (entry: PooledWebSocketEntry): boolean =>
  entry.pooled
  && !entry.closed
  && entry.requestCount === 0
  && websocketPool.get(entry.identity.poolKey) === entry

const getIdleConnectionCount = (): number => {
  let count = 0
  for (const entry of websocketEntries) {
    if (isIdlePooledEntry(entry)) {
      count += 1
    }
  }
  return count
}

const getDedicatedConnectionCount = (): number => {
  let count = 0
  for (const entry of websocketEntries) {
    if (!entry.pooled) {
      count += 1
    }
  }
  return count
}

const clearPooledWebSocketIdleTimer = (entry: PooledWebSocketEntry): void => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

const retirePooledWebSocketEntry = (entry: PooledWebSocketEntry): void => {
  if (websocketPool.get(entry.identity.poolKey) === entry) {
    websocketPool.delete(entry.identity.poolKey)
  }
  if (!entry.closed) {
    entry.closed = true
    clearPooledWebSocketIdleTimer(entry)
    closeResponsesWebSocket(entry.websocket)
  }
  if (entry.websocket.readyState === WebSocket.CLOSED) {
    finalizePooledWebSocketEntry(entry)
  }
}

const finalizePooledWebSocketEntry = (entry: PooledWebSocketEntry): void => {
  if (websocketEntries.delete(entry)) {
    decrementCapacityKeyConnectionCount(entry.identity.capacityKey)
    notifyCapacityChanged()
  }
}

const getPooledWebSocketActiveRequestCount = (
  poolKey: ResponsesWebSocketPoolKey,
): number => websocketActiveRequests.get(poolKey) ?? 0

const incrementPooledWebSocketActiveRequestCount = (
  poolKey: ResponsesWebSocketPoolKey,
): void => {
  websocketActiveRequests.set(
    poolKey,
    getPooledWebSocketActiveRequestCount(poolKey) + 1,
  )
}

const decrementPooledWebSocketActiveRequestCount = (
  poolKey: ResponsesWebSocketPoolKey,
): void => {
  const nextCount = getPooledWebSocketActiveRequestCount(poolKey) - 1
  if (nextCount <= 0) {
    websocketActiveRequests.delete(poolKey)
  } else {
    websocketActiveRequests.set(poolKey, nextCount)
  }
}

const getCapacityKeyConnectionCount = (
  capacityKey: ResponsesWebSocketCapacityKey,
): number => websocketConnectionsByCapacityKey.get(capacityKey) ?? 0

const incrementCapacityKeyConnectionCount = (
  capacityKey: ResponsesWebSocketCapacityKey,
): void => {
  websocketConnectionsByCapacityKey.set(
    capacityKey,
    getCapacityKeyConnectionCount(capacityKey) + 1,
  )
}

const decrementCapacityKeyConnectionCount = (
  capacityKey: ResponsesWebSocketCapacityKey,
): void => {
  const nextCount = getCapacityKeyConnectionCount(capacityKey) - 1
  if (nextCount <= 0) {
    websocketConnectionsByCapacityKey.delete(capacityKey)
  } else {
    websocketConnectionsByCapacityKey.set(capacityKey, nextCount)
  }
}

const waitForWebSocketCapacityChange = async (
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => settle(resolve), timeoutMs)
    timer.unref?.()

    const cleanup = () => {
      clearTimeout(timer)
      capacityWaiters.delete(onCapacityChanged)
      signal?.removeEventListener("abort", onAbort)
    }
    const settle = (callback: () => void) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    const onCapacityChanged = () => settle(resolve)
    const onAbort = () =>
      settle(() => reject(toResponsesWebSocketAbortError(signal?.reason)))

    capacityWaiters.add(onCapacityChanged)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

const notifyCapacityChanged = (): void => {
  for (const notify of [...capacityWaiters]) {
    notify()
  }
}

interface WebSocketCloseEvent {
  code?: number
  reason?: string
  wasClean?: boolean
}

const logWebSocketClose = (
  entry: PooledWebSocketEntry,
  event: WebSocketCloseEvent,
): void => {
  if (entry.closeLogged) {
    return
  }
  entry.closeLogged = true
  entry.onClose({
    closeCode:
      typeof event.code === "number" && Number.isFinite(event.code) ?
        event.code
      : null,
    closeReason: event.reason ? "provided" : "none",
    connectionAgeMs: Math.max(0, Date.now() - entry.createdAt),
    pooled: entry.pooled,
    readyState: entry.websocket.readyState,
    reused: entry.lastReused,
    wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
  })
}

const sumMapValues = <TKey>(values: Map<TKey, number>): number => {
  let sum = 0
  for (const value of values.values()) {
    sum += value
  }
  return sum
}
