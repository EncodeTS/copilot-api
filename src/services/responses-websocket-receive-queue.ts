import { WebSocket } from "undici"

import type { ResponsesWebSocketResourceLimits } from "~/lib/responses-websocket-limits"
import {
  resolveUpstreamLifecycleTimeouts,
  UpstreamLifecycleTimeoutError,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import {
  closeResponsesWebSocket,
  createResponsesWebSocketError,
  toResponsesWebSocketAbortError,
  toResponsesWebSocketError,
  type ResponsesWebSocketErrorEvent,
} from "~/services/responses-websocket-runtime"

interface QueuedWebSocketMessage {
  bytes: number
  data: unknown
}

export interface WebSocketQueueOverflowDetails {
  frameBytes: number
  maxFrameBytes: number
  maxQueuedBytes: number
  maxQueuedFrames: number
  queuedBytes: number
  queuedFrames: number
}

export interface WebSocketReceiveQueueDiagnostics {
  overflows: number
  queuedBytes: number
  queuedFrames: number
}

export interface WebSocketReceiveQueueOptions {
  limits: ResponsesWebSocketResourceLimits
  onFrame: () => void
  onOverflow: (details: WebSocketQueueOverflowDetails) => void
  signal?: AbortSignal
  streamErrorMessage: string
  timeouts?: UpstreamLifecycleTimeouts
}

export class WebSocketQueueOverflowError extends Error {
  readonly frameBytes: number
  readonly maxFrameBytes: number
  readonly maxQueuedBytes: number
  readonly maxQueuedFrames: number
  readonly queuedBytes: number
  readonly queuedFrames: number

  constructor(details: WebSocketQueueOverflowDetails) {
    super("Responses websocket receive queue exceeded its configured limit")
    this.name = "WebSocketQueueOverflowError"
    this.frameBytes = details.frameBytes
    this.maxFrameBytes = details.maxFrameBytes
    this.maxQueuedBytes = details.maxQueuedBytes
    this.maxQueuedFrames = details.maxQueuedFrames
    this.queuedBytes = details.queuedBytes
    this.queuedFrames = details.queuedFrames
  }
}

let queueOverflows = 0
let queuedBytes = 0
let queuedFrames = 0

export const getWebSocketReceiveQueueDiagnostics =
  (): WebSocketReceiveQueueDiagnostics => ({
    overflows: queueOverflows,
    queuedBytes,
    queuedFrames,
  })

export const createBoundedWebSocketMessageStream = async function* (
  websocket: InstanceType<typeof WebSocket>,
  options: WebSocketReceiveQueueOptions,
): AsyncIterable<string> {
  const queue: Array<QueuedWebSocketMessage | undefined> = []
  let queueHead = 0
  let localQueuedBytes = 0
  let localQueuedFrames = 0
  let closed = false
  let error: Error | null = null
  let overflowError: WebSocketQueueOverflowError | null = null
  let notify: (() => void) | null = null
  let receivedFrame = false
  const timeouts = resolveUpstreamLifecycleTimeouts(options.timeouts)
  const startedAt = Date.now()

  const wake = () => {
    notify?.()
    notify = null
  }

  const clearQueue = () => {
    queuedBytes -= localQueuedBytes
    queuedFrames -= localQueuedFrames
    localQueuedBytes = 0
    localQueuedFrames = 0
    queue.length = 0
    queueHead = 0
  }

  const onMessage = (event: { data: unknown }) => {
    options.onFrame()
    receivedFrame = true
    if (overflowError) {
      return
    }

    const frameBytes = measureWebSocketMessageBytes(event.data)
    const nextQueuedBytes = localQueuedBytes + frameBytes
    const nextQueuedFrames = localQueuedFrames + 1
    if (
      frameBytes > options.limits.maxFrameBytes
      || nextQueuedBytes > options.limits.maxQueuedBytes
      || nextQueuedFrames > options.limits.maxQueuedFrames
    ) {
      const details = {
        frameBytes,
        maxFrameBytes: options.limits.maxFrameBytes,
        maxQueuedBytes: options.limits.maxQueuedBytes,
        maxQueuedFrames: options.limits.maxQueuedFrames,
        queuedBytes: localQueuedBytes,
        queuedFrames: localQueuedFrames,
      }
      overflowError = new WebSocketQueueOverflowError(details)
      queueOverflows += 1
      options.onOverflow(details)
      clearQueue()
      closeResponsesWebSocket(websocket, 1009, "receive queue limit exceeded")
      wake()
      return
    }

    queue.push({ bytes: frameBytes, data: event.data })
    localQueuedBytes = nextQueuedBytes
    localQueuedFrames = nextQueuedFrames
    queuedBytes += frameBytes
    queuedFrames += 1
    wake()
  }

  const onClose = () => {
    closed = true
    wake()
  }

  const onError = (event: ResponsesWebSocketErrorEvent) => {
    error = createResponsesWebSocketError(options.streamErrorMessage, event)
    wake()
  }

  websocket.addEventListener("message", onMessage)
  websocket.addEventListener("close", onClose)
  websocket.addEventListener("error", onError)

  try {
    while (true) {
      const currentOverflowError: WebSocketQueueOverflowError | null =
        overflowError
      if (currentOverflowError) {
        throw toResponsesWebSocketError(currentOverflowError)
      }

      const totalElapsedMs = Date.now() - startedAt
      if (totalElapsedMs >= timeouts.websocketTotalMs) {
        throw new UpstreamLifecycleTimeoutError(
          "WebSocket total",
          timeouts.websocketTotalMs,
        )
      }

      const item = queue[queueHead]
      if (item) {
        queue[queueHead] = undefined
        queueHead += 1
        localQueuedBytes -= item.bytes
        localQueuedFrames -= 1
        queuedBytes -= item.bytes
        queuedFrames -= 1
        queueHead = compactWebSocketQueue(queue, queueHead)
        if (queueHead >= queue.length) {
          queue.length = 0
          queueHead = 0
        }
        yield await normalizeWebSocketMessageData(item.data)
        continue
      }

      if (error) {
        throw toResponsesWebSocketError(error)
      }
      if (closed) {
        break
      }

      const activityPhase =
        receivedFrame ? "WebSocket inactivity" : "WebSocket first frame"
      const activityTimeoutMs =
        receivedFrame ?
          timeouts.websocketInactivityMs
        : timeouts.websocketFirstFrameMs
      const totalRemainingMs = timeouts.websocketTotalMs - totalElapsedMs
      const totalExpiresFirst = totalRemainingMs <= activityTimeoutMs

      await waitForWebSocketWake({
        phase: totalExpiresFirst ? "WebSocket total" : activityPhase,
        reportedTimeoutMs:
          totalExpiresFirst ? timeouts.websocketTotalMs : activityTimeoutMs,
        signal: options.signal,
        timeoutMs: Math.max(1, Math.min(activityTimeoutMs, totalRemainingMs)),
        setNotify: (nextNotify) => {
          notify = nextNotify
        },
      })
    }
  } finally {
    websocket.removeEventListener("message", onMessage)
    websocket.removeEventListener("close", onClose)
    websocket.removeEventListener("error", onError)
    clearQueue()
  }
}

const compactWebSocketQueue = (
  queue: Array<QueuedWebSocketMessage | undefined>,
  queueHead: number,
): number => {
  if (queueHead < 1024 || queueHead * 2 < queue.length) {
    return queueHead
  }
  queue.splice(0, queueHead)
  return 0
}

const measureWebSocketMessageBytes = (data: unknown): number => {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8")
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
  }
  if (isSizedData(data)) {
    return data.size
  }
  return Buffer.byteLength(String(data), "utf8")
}

const isSizedData = (value: unknown): value is { size: number } =>
  typeof value === "object"
  && value !== null
  && "size" in value
  && typeof value.size === "number"
  && Number.isSafeInteger(value.size)
  && value.size >= 0

const waitForWebSocketWake = async ({
  phase,
  reportedTimeoutMs,
  setNotify,
  signal,
  timeoutMs,
}: {
  phase: string
  reportedTimeoutMs?: number
  setNotify: (notify: () => void) => void
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
      }
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
    const onAbort = () =>
      settle(() => reject(toResponsesWebSocketAbortError(signal?.reason)))

    setNotify(() => settle(resolve))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        settle(() =>
          reject(
            new UpstreamLifecycleTimeoutError(
              phase,
              reportedTimeoutMs ?? timeoutMs,
            ),
          ),
        )
      }, timeoutMs)
      unrefTimer(timer)
    }
  })

const normalizeWebSocketMessageData = async (
  data: unknown,
): Promise<string> => {
  if (typeof data === "string") {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data)
  }
  if (ArrayBuffer.isView(data)) {
    const view = data
    return new TextDecoder().decode(
      new Uint8Array(
        view.buffer as ArrayBuffer,
        view.byteOffset,
        view.byteLength,
      ),
    )
  }
  if (isTextReadable(data)) {
    return await data.text()
  }
  return String(data)
}

const isTextReadable = (
  value: unknown,
): value is { text: () => Promise<string> } => {
  if (!value || typeof value !== "object" || !("text" in value)) {
    return false
  }
  return typeof (value as { text?: unknown }).text === "function"
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  timer.unref?.()
}
