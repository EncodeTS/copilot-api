import consola from "consola"
import { WebSocket } from "undici"

import { resolveProxyUrlForUrl } from "~/lib/proxy"
import type { ResponsesWebSocketResourceLimits } from "~/lib/responses-websocket-limits"
import {
  UpstreamLifecycleTimeoutError,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import { type PooledWebSocketIdentity } from "~/services/responses-websocket-identity"
import {
  acquirePooledWebSocketConnection,
  clearPooledWebSocketRegistry,
  getWebSocketConnectionRegistryDiagnostics,
  WebSocketConnectionCapacityError,
  type OpeningWebSocket,
  type PooledWebSocketLease,
} from "~/services/responses-websocket-registry"
import {
  createBoundedWebSocketMessageStream,
  getWebSocketReceiveQueueDiagnostics,
  WebSocketQueueOverflowError,
  type WebSocketQueueOverflowDetails,
} from "~/services/responses-websocket-receive-queue"
import {
  closeResponsesWebSocket,
  createResponsesWebSocketError,
  toResponsesWebSocketAbortError,
  toResponsesWebSocketError,
  type ResponsesWebSocketErrorEvent,
} from "~/services/responses-websocket-runtime"

export {
  createPooledWebSocketIdentity,
  type PooledWebSocketIdentity,
  type PooledWebSocketIdentityParts,
} from "~/services/responses-websocket-identity"

interface PooledWebSocketRequestBase {
  headers: Record<string, string>
  identity: PooledWebSocketIdentity
  resourceLimits: ResponsesWebSocketResourceLimits
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
  url: string
}

export type PooledWebSocketRequest<TPayload> = PooledWebSocketRequestBase
  & ({ frame: string; payload?: never } | { frame?: never; payload: TPayload })

export interface PooledWebSocketStreamOptions<TChunk> {
  createChunk: (data: string) => TChunk
  isReusableTerminalChunk?: (chunk: TChunk) => boolean
  isTerminalChunk: (chunk: TChunk) => boolean
  openErrorMessage: string
  streamErrorMessage: string
  terminalChunkMissingMessage: string
  unavailableErrorMessage?: string
}

export interface PooledWebSocketDiagnostics {
  activeRequests: number
  connections: number
  dedicatedConnections: number
  idleConnections: number
  overflows: number
  poolHits: number
  poolMisses: number
  pooledConnections: number
  queuedBytes: number
  queuedFrames: number
}

export type WebSocketRequestSendState =
  | "not-sent"
  | "sent-unknown"
  | "frame-seen"

export type PooledWebSocketClearReason = "network_change" | "proxy_change"

export class PooledWebSocketRequestError extends Error {
  readonly sendState: WebSocketRequestSendState

  constructor(sendState: WebSocketRequestSendState, cause: Error) {
    super(cause.message, { cause })
    this.name = "PooledWebSocketRequestError"
    this.sendState = sendState
  }
}

export class PooledWebSocketCapacityError extends PooledWebSocketRequestError {
  readonly code = "websocket_capacity_exceeded"

  constructor() {
    super(
      "not-sent",
      new Error("Responses websocket connection capacity is exhausted"),
    )
    this.name = "PooledWebSocketCapacityError"
  }
}

export class PooledWebSocketQueueOverflowError extends PooledWebSocketRequestError {
  readonly code = "websocket_queue_overflow"
  readonly frameBytes: number
  readonly maxFrameBytes: number
  readonly maxQueuedBytes: number
  readonly maxQueuedFrames: number
  readonly queuedBytes: number
  readonly queuedFrames: number

  constructor(
    sendState: WebSocketRequestSendState,
    cause: WebSocketQueueOverflowError,
  ) {
    super(sendState, cause)
    this.name = "PooledWebSocketQueueOverflowError"
    this.frameBytes = cause.frameBytes
    this.maxFrameBytes = cause.maxFrameBytes
    this.maxQueuedBytes = cause.maxQueuedBytes
    this.maxQueuedFrames = cause.maxQueuedFrames
    this.queuedBytes = cause.queuedBytes
    this.queuedFrames = cause.queuedFrames
  }
}

export const isWebSocketNotSentError = (
  error: unknown,
): error is PooledWebSocketRequestError =>
  error instanceof PooledWebSocketRequestError && error.sendState === "not-sent"

export const createWebSocketUrl = (url: string): string => {
  const websocketUrl = new URL(url)
  if (websocketUrl.protocol === "https:") {
    websocketUrl.protocol = "wss:"
  } else if (websocketUrl.protocol === "http:") {
    websocketUrl.protocol = "ws:"
  }
  return websocketUrl.toString()
}

export const getPooledWebSocketDiagnostics =
  (): PooledWebSocketDiagnostics => ({
    ...getWebSocketConnectionRegistryDiagnostics(),
    ...getWebSocketReceiveQueueDiagnostics(),
  })

export const clearPooledWebSocketConnections = (
  reason: PooledWebSocketClearReason,
): number => {
  const clearedConnections = clearPooledWebSocketRegistry()
  emitWebSocketDiagnostic("pool_cleared", { clearedConnections, reason })
  return clearedConnections
}

export const createPooledWebSocketStream = <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): AsyncIterable<TChunk> => runPooledWebSocketRequest(request, options)

const runPooledWebSocketRequest = async function* <TPayload, TChunk>(
  request: PooledWebSocketRequest<TPayload>,
  options: PooledWebSocketStreamOptions<TChunk>,
): AsyncIterable<TChunk> {
  let lease: PooledWebSocketLease | undefined
  let reachedTerminal = false
  let receivedFrame = false
  let sendAttempted = false

  try {
    const hasFrame = Object.hasOwn(request, "frame")
    const hasPayload = Object.hasOwn(request, "payload")
    if (hasFrame === hasPayload) {
      throw new TypeError(
        "Responses websocket request must contain exactly one wire source",
      )
    }
    const frame = hasFrame ? request.frame! : JSON.stringify(request.payload)
    const requestFrameBytes = Buffer.byteLength(frame, "utf8")
    lease = await acquirePooledWebSocketConnection({
      identity: request.identity,
      limits: request.resourceLimits,
      onClose: (diagnostic) => {
        emitWebSocketDiagnostic("connection_closed", { ...diagnostic })
      },
      open: (connectTimeoutMs) =>
        openWebSocket({
          connectTimeoutMs,
          headers: request.headers,
          openErrorMessage: options.openErrorMessage,
          signal: request.signal,
          url: request.url,
        }),
      signal: request.signal,
      timeouts: request.timeouts,
    })
    const websocket = await lease.ready(options.unavailableErrorMessage)
    emitWebSocketDiagnostic("request_started", {
      connectionAgeMs: lease.connectionAgeMs(),
      pooled: lease.pooled,
      readyState: websocket.readyState,
      requestFrameBytes,
      reused: lease.reused,
    })
    sendAttempted = true
    websocket.send(frame)

    for await (const data of createBoundedWebSocketMessageStream(websocket, {
      limits: request.resourceLimits,
      onFrame: () => {
        receivedFrame = true
      },
      onOverflow: logQueueOverflow,
      signal: request.signal,
      streamErrorMessage: options.streamErrorMessage,
      timeouts: request.timeouts,
    })) {
      const chunk = options.createChunk(data)
      const isTerminal = options.isTerminalChunk(chunk)
      if (isTerminal) {
        reachedTerminal = true
        if (
          options.isReusableTerminalChunk
          && !options.isReusableTerminalChunk(chunk)
        ) {
          lease.retire()
        }
      }
      yield chunk
      if (isTerminal) {
        return
      }
    }

    lease.retire()
    throw new Error(options.terminalChunkMissingMessage)
  } catch (error) {
    lease?.retire()
    if (error instanceof PooledWebSocketRequestError) {
      throw error
    }
    if (error instanceof WebSocketConnectionCapacityError) {
      emitWebSocketDiagnostic("capacity_rejected", {})
      throw new PooledWebSocketCapacityError()
    }
    const sendState =
      receivedFrame ? "frame-seen"
      : sendAttempted ? "sent-unknown"
      : "not-sent"
    if (error instanceof WebSocketQueueOverflowError) {
      throw new PooledWebSocketQueueOverflowError(sendState, error)
    }
    throw new PooledWebSocketRequestError(
      sendState,
      toResponsesWebSocketError(error),
    )
  } finally {
    if (lease && !reachedTerminal) {
      lease.retire()
    }
    lease?.release()
  }
}

const logQueueOverflow = (details: WebSocketQueueOverflowDetails): void => {
  emitWebSocketDiagnostic("queue_overflow", {
    frameBytes: details.frameBytes,
    maxFrameBytes: details.maxFrameBytes,
    maxQueuedBytes: details.maxQueuedBytes,
    maxQueuedFrames: details.maxQueuedFrames,
    socketQueuedBytes: details.queuedBytes,
    socketQueuedFrames: details.queuedFrames,
  })
}

const emitWebSocketDiagnostic = (
  event: string,
  fields: Record<string, boolean | null | number | string>,
): void => {
  consola.debug("responses.websocket", {
    ...getPooledWebSocketDiagnostics(),
    ...fields,
    event,
  })
}

const openWebSocket = ({
  connectTimeoutMs,
  headers,
  openErrorMessage,
  signal,
  url,
}: {
  connectTimeoutMs: number
  headers: Record<string, string>
  openErrorMessage: string
  signal?: AbortSignal
  url: string
}): OpeningWebSocket => {
  const proxy = typeof Bun === "undefined" ? undefined : getProxyUrl(url)
  const init = { headers, ...(proxy ? { proxy } : {}) }
  const websocket = new WebSocket(url, init)
  const websocketPromise = new Promise<InstanceType<typeof WebSocket>>(
    (resolve, reject) => {
      const connectTimer = setTimeout(() => {
        fail(
          new UpstreamLifecycleTimeoutError(
            "WebSocket connect",
            connectTimeoutMs,
          ),
        )
      }, connectTimeoutMs)
      connectTimer.unref?.()

      const cleanup = () => {
        clearTimeout(connectTimer)
        websocket.removeEventListener("open", onOpen)
        websocket.removeEventListener("error", onError)
        websocket.removeEventListener("close", onClose)
        signal?.removeEventListener("abort", onAbort)
      }
      const fail = (error: Error) => {
        cleanup()
        closeResponsesWebSocket(websocket)
        reject(error)
      }
      const onOpen = () => {
        cleanup()
        resolve(websocket)
      }
      const onError = (event: ResponsesWebSocketErrorEvent) => {
        fail(createResponsesWebSocketError(openErrorMessage, event))
      }
      const onClose = () => fail(new Error(openErrorMessage))
      const onAbort = () => fail(toResponsesWebSocketAbortError(signal?.reason))

      websocket.addEventListener("open", onOpen)
      websocket.addEventListener("error", onError)
      websocket.addEventListener("close", onClose)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener("abort", onAbort, { once: true })
    },
  )
  return { websocket, websocketPromise }
}

const getProxyUrl = (url: string): string =>
  resolveProxyUrlForUrl(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"))
  ?? ""
