import {
  classifyResponsesStreamTerminalEvent,
  parseResponsesStreamEventData,
  RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE,
  type ResponsesStreamEvent,
  type ResponsesStreamParseResult,
  type ResponsesStreamTerminalKind,
} from "~/lib/responses-stream-protocol"
import {
  addSaturatingCounter,
  incrementSaturatingCounter,
} from "~/lib/saturating-counter"
import {
  normalizeResponsesAiu,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage/normalize-responses"
import { UpstreamLifecycleTimeoutError } from "~/lib/upstream-lifecycle"

export interface ResponsesStreamSessionChunk {
  comment?: string
  data?: string
  event?: string
  id?: number | string
  retry?: number
}

export type ResponsesStreamSessionWireEnvelope = Readonly<{
  comment: string | undefined
  data: string | undefined
  event: string | undefined
  id: number | string | undefined
  retry: number | undefined
}>

export type ResponsesStreamSessionFrame =
  | { kind: "done"; wire: ResponsesStreamSessionWireEnvelope }
  | { kind: "envelope"; wire: ResponsesStreamSessionWireEnvelope }
  | {
      kind: "event"
      event: ResponsesStreamEvent
      terminal: ResponsesStreamSessionTerminalSnapshot | null
      wire: ResponsesStreamSessionWireEnvelope
    }
  | {
      kind: "malformed"
      parsed?: unknown
      wire: ResponsesStreamSessionWireEnvelope
    }
  | { kind: "ping"; wire: ResponsesStreamSessionWireEnvelope }
  | {
      kind: "unknown"
      parsed: unknown
      wire: ResponsesStreamSessionWireEnvelope
    }

export interface ResponsesStreamSessionDiagnostics {
  doneCount: number
  elapsedMs: number
  envelopeCount: number
  eventCount: number
  frameCount: number
  lastEventType: ResponsesStreamEvent["type"] | null
  malformedCount: number
  pingCount: number
  terminalSeen: boolean
  unknownCount: number
}

export interface ResponsesStreamSessionEofOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  endedBy: "done" | "source"
  kind: "eof"
  terminal: null
}

export interface ResponsesStreamSessionCompletedOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "completed"
  terminal: Extract<
    ResponsesStreamSessionTerminalSnapshot,
    { kind: "completed" }
  >
}

export interface ResponsesStreamSessionIncompleteOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "incomplete"
  terminal: Extract<
    ResponsesStreamSessionTerminalSnapshot,
    { kind: "incomplete" }
  >
}

export interface ResponsesStreamSessionFailedOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "failed"
  terminal: Extract<ResponsesStreamSessionTerminalSnapshot, { kind: "failed" }>
}

export interface ResponsesStreamSessionErrorOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "error"
  terminal: Extract<ResponsesStreamSessionTerminalSnapshot, { kind: "error" }>
}

export interface ResponsesStreamSessionThrowOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  error: unknown
  kind: "throw"
  terminal: null
}

export interface ResponsesStreamSessionTimeoutOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  error: UpstreamLifecycleTimeoutError
  kind: "timeout"
  terminal: ResponsesStreamSessionTerminalSnapshot | null
}

export interface ResponsesStreamSessionAbortOutcome {
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "abort"
  reason: unknown
  terminal: ResponsesStreamSessionTerminalSnapshot | null
}

export type ResponsesStreamSessionTerminalKind = ResponsesStreamTerminalKind

export type ResponsesStreamSessionTerminalSnapshot =
  | Readonly<{
      event: Readonly<
        Extract<ResponsesStreamEvent, { type: "response.completed" }>
      >
      kind: "completed"
      usage: Readonly<UsageTokens>
    }>
  | Readonly<{
      event: Readonly<Extract<ResponsesStreamEvent, { type: "error" }>>
      kind: "error"
      usage: Readonly<UsageTokens>
    }>
  | Readonly<{
      event: Readonly<
        Extract<ResponsesStreamEvent, { type: "response.failed" }>
      >
      kind: "failed"
      usage: Readonly<UsageTokens>
    }>
  | Readonly<{
      event: Readonly<
        Extract<ResponsesStreamEvent, { type: "response.incomplete" }>
      >
      kind: "incomplete"
      usage: Readonly<UsageTokens>
    }>

export interface ResponsesStreamSessionDeliveryFailedOutcome {
  deliveryError: unknown
  diagnostics: ResponsesStreamSessionDiagnostics
  kind: "delivery_failed"
  terminal: ResponsesStreamSessionTerminalSnapshot | null
}

export type ResponsesStreamSessionOutcome =
  | ResponsesStreamSessionAbortOutcome
  | ResponsesStreamSessionCompletedOutcome
  | ResponsesStreamSessionDeliveryFailedOutcome
  | ResponsesStreamSessionEofOutcome
  | ResponsesStreamSessionErrorOutcome
  | ResponsesStreamSessionFailedOutcome
  | ResponsesStreamSessionIncompleteOutcome
  | ResponsesStreamSessionThrowOutcome
  | ResponsesStreamSessionTimeoutOutcome

export interface RunResponsesStreamSessionOptions {
  onFrame?: (frame: ResponsesStreamSessionFrame) => PromiseLike<void> | void
  signal?: AbortSignal
  source: AsyncIterable<ResponsesStreamSessionChunk>
}

const EMPTY_USAGE: Readonly<UsageTokens> = Object.freeze({})

class ResponsesFrameDeliveryError extends Error {
  readonly deliveryError: unknown
  readonly terminal: ResponsesStreamSessionTerminalSnapshot | null

  constructor(
    deliveryError: unknown,
    terminal: ResponsesStreamSessionTerminalSnapshot | null,
  ) {
    super(
      "Responses stream frame delivery failed",
      deliveryError instanceof Error ? { cause: deliveryError } : undefined,
    )
    this.name = "ResponsesFrameDeliveryError"
    this.deliveryError = deliveryError
    this.terminal = terminal
  }
}

class ResponsesFrameDeliveryInterrupted extends Error {
  readonly terminal: ResponsesStreamSessionTerminalSnapshot | null

  constructor(terminal: ResponsesStreamSessionTerminalSnapshot | null) {
    super("Responses stream frame delivery interrupted")
    this.name = "ResponsesFrameDeliveryInterrupted"
    this.terminal = terminal
  }
}

export const runResponsesStreamSession = async ({
  onFrame,
  signal,
  source,
}: RunResponsesStreamSessionOptions): Promise<ResponsesStreamSessionOutcome> => {
  const startedAt = Date.now()
  const diagnostics: ResponsesStreamSessionDiagnostics = {
    doneCount: 0,
    elapsedMs: 0,
    envelopeCount: 0,
    eventCount: 0,
    frameCount: 0,
    lastEventType: null,
    malformedCount: 0,
    pingCount: 0,
    terminalSeen: false,
    unknownCount: 0,
  }

  const initialInterruption = getSignalOutcome(signal, diagnostics, startedAt)
  if (initialInterruption) return initialInterruption

  let iterator: AsyncIterator<ResponsesStreamSessionChunk>
  try {
    iterator = source[Symbol.asyncIterator]()
  } catch (error) {
    setElapsed(diagnostics, startedAt)
    return classifySessionFailure(error, signal, diagnostics)
  }
  const closeIterator = createIteratorCloser(iterator)
  try {
    while (true) {
      const interruption = getSignalOutcome(signal, diagnostics, startedAt)
      if (interruption) {
        closeIterator()
        return interruption
      }

      const read = await readIteratorWithSignal(iterator, signal)
      if (read.kind === "interrupted") {
        closeIterator()
        return getSignalOutcome(signal, diagnostics, startedAt)!
      }
      if (read.result.done) break

      const chunk = read.result.value
      const wire = snapshotWireEnvelope(chunk)
      incrementSaturatingCounter(diagnostics, "frameCount")

      if (chunk.event === "ping") {
        incrementSaturatingCounter(diagnostics, "pingCount")
        await deliverFrame(onFrame, { kind: "ping", wire }, null, signal)
        continue
      }

      if (!chunk.data) {
        if (hasSelectedWireProjection(chunk)) {
          incrementSaturatingCounter(diagnostics, "envelopeCount")
          await deliverFrame(onFrame, { kind: "envelope", wire }, null, signal)
        }
        continue
      }

      if (chunk.data === "[DONE]") {
        incrementSaturatingCounter(diagnostics, "doneCount")
        await deliverFrame(onFrame, { kind: "done", wire }, null, signal)
        const interruption = getSignalOutcome(signal, diagnostics, startedAt)
        if (interruption) {
          closeIterator()
          return interruption
        }
        closeIterator()
        setElapsed(diagnostics, startedAt)
        return {
          diagnostics,
          endedBy: "done",
          kind: "eof",
          terminal: null,
        }
      }

      const parsedResult: ResponsesStreamParseResult =
        parseResponsesStreamEventData(chunk.data)

      if (parsedResult.kind === "malformed") {
        incrementSaturatingCounter(diagnostics, "malformedCount")
        await deliverFrame(
          onFrame,
          { kind: "malformed", parsed: parsedResult.parsed, wire },
          null,
          signal,
        )
        continue
      }

      if (parsedResult.kind === "unknown") {
        incrementSaturatingCounter(diagnostics, "unknownCount")
        await deliverFrame(
          onFrame,
          { kind: "unknown", parsed: parsedResult.parsed, wire },
          null,
          signal,
        )
        continue
      }

      const { event } = parsedResult
      incrementSaturatingCounter(diagnostics, "eventCount")
      diagnostics.lastEventType = event.type
      const terminal = createTerminalSnapshot(event)
      if (terminal) diagnostics.terminalSeen = true
      await deliverFrame(
        onFrame,
        { event, kind: "event", terminal, wire },
        terminal,
        signal,
      )

      if (terminal) {
        closeIterator()
        setElapsed(diagnostics, startedAt)
        switch (terminal.kind) {
          case "completed":
            return {
              diagnostics,
              kind: "completed",
              terminal,
            }
          case "error":
            return {
              diagnostics,
              kind: "error",
              terminal,
            }
          case "failed":
            return {
              diagnostics,
              kind: "failed",
              terminal,
            }
          case "incomplete":
            return {
              diagnostics,
              kind: "incomplete",
              terminal,
            }
        }
      }
    }
  } catch (error) {
    closeIterator()
    setElapsed(diagnostics, startedAt)
    if (error instanceof ResponsesFrameDeliveryInterrupted) {
      const interruption = getSignalOutcome(
        signal,
        diagnostics,
        startedAt,
        error.terminal,
      )
      if (interruption) return interruption
    }
    if (error instanceof ResponsesFrameDeliveryError) {
      return {
        deliveryError: error.deliveryError,
        diagnostics,
        kind: "delivery_failed",
        terminal: error.terminal,
      }
    }
    return classifySessionFailure(error, signal, diagnostics)
  }

  const finalInterruption = getSignalOutcome(signal, diagnostics, startedAt)
  if (finalInterruption) {
    closeIterator()
    return finalInterruption
  }
  setElapsed(diagnostics, startedAt)
  return {
    diagnostics,
    endedBy: "source",
    kind: "eof",
    terminal: null,
  }
}

const snapshotWireEnvelope = (
  chunk: ResponsesStreamSessionChunk,
): ResponsesStreamSessionWireEnvelope =>
  Object.freeze({
    comment: chunk.comment,
    data: chunk.data,
    event: chunk.event,
    id: chunk.id,
    retry: chunk.retry,
  })

const hasSelectedWireProjection = (
  chunk: ResponsesStreamSessionChunk,
): boolean =>
  chunk.comment !== undefined
  || chunk.data !== undefined
  || chunk.event !== undefined
  || chunk.id !== undefined
  || chunk.retry !== undefined

type IteratorRead<T> =
  | { kind: "interrupted" }
  | { kind: "read"; result: IteratorResult<T> }

type SignalRaceResult<T> =
  | { kind: "interrupted" }
  | { kind: "resolved"; value: T }

const racePromiseWithSignal = async <T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<SignalRaceResult<T>> => {
  if (signal?.aborted) return { kind: "interrupted" }
  if (!signal) return { kind: "resolved", value: await pending }

  let onAbort: () => void = () => {}
  const interrupted = new Promise<SignalRaceResult<T>>((resolve) => {
    onAbort = () => resolve({ kind: "interrupted" })
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([
      pending.then((value) => ({ kind: "resolved" as const, value })),
      interrupted,
    ])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

const readIteratorWithSignal = async <T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): Promise<IteratorRead<T>> => {
  const pendingRead = Promise.resolve().then(() => iterator.next())
  const read = await racePromiseWithSignal(pendingRead, signal)
  return read.kind === "interrupted" ?
      read
    : { kind: "read", result: read.value }
}

const createIteratorCloser = <T>(iterator: AsyncIterator<T>): (() => void) => {
  let closed = false
  return () => {
    if (closed) return
    closed = true
    try {
      const cleanup = iterator.return?.()
      if (cleanup) void Promise.resolve(cleanup).catch(() => {})
    } catch {
      // Iterator cleanup is best-effort and must not replace the session truth.
    }
  }
}

const createTerminalSnapshot = (
  event: ResponsesStreamEvent,
): ResponsesStreamSessionTerminalSnapshot | null => {
  const terminal = classifyResponsesStreamTerminalEvent(event)
  if (!terminal) return null

  switch (terminal.event.type) {
    case "response.completed":
      return freezeTerminalSnapshot(
        RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE[terminal.event.type],
        terminal.event,
        normalizeTerminalUsage(terminal.event),
      )
    case "response.incomplete":
      return freezeTerminalSnapshot(
        RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE[terminal.event.type],
        terminal.event,
        normalizeTerminalUsage(terminal.event),
      )
    case "response.failed":
      return freezeTerminalSnapshot(
        RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE[terminal.event.type],
        terminal.event,
        normalizeTerminalUsage(terminal.event),
      )
    case "error":
      return freezeTerminalSnapshot(
        RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE[terminal.event.type],
        terminal.event,
        EMPTY_USAGE,
      )
  }
}

const freezeTerminalSnapshot = <
  TKind extends ResponsesStreamSessionTerminalKind,
  TEvent extends Extract<
    ResponsesStreamEvent,
    {
      type:
        | "error"
        | "response.completed"
        | "response.failed"
        | "response.incomplete"
    }
  >,
>(
  kind: TKind,
  event: TEvent,
  usage: UsageTokens,
): Readonly<{
  event: Readonly<TEvent>
  kind: TKind
  usage: Readonly<UsageTokens>
}> =>
  Object.freeze({
    event: deepFreeze(event),
    kind,
    usage: Object.freeze({ ...usage }),
  })

const deepFreeze = <T extends object>(
  value: T,
  seen = new WeakSet<object>(),
): Readonly<T> => {
  if (seen.has(value)) return value
  seen.add(value)
  for (const nested of Object.values(value)) {
    if (typeof nested === "object" && nested !== null) {
      deepFreeze(nested, seen)
    }
  }
  return Object.freeze(value)
}

const deliverFrame = async (
  onFrame:
    | ((frame: ResponsesStreamSessionFrame) => PromiseLike<void> | void)
    | undefined,
  frame: ResponsesStreamSessionFrame,
  terminal: ResponsesStreamSessionTerminalSnapshot | null,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (!onFrame) return
  if (signal?.aborted) {
    throw new ResponsesFrameDeliveryInterrupted(terminal)
  }

  const pendingDelivery = Promise.resolve()
    .then(() => onFrame(frame))
    .then<FrameDeliveryResult, FrameDeliveryResult>(
      () => ({ kind: "delivered" }),
      (error: unknown) =>
        signal?.aborted ? { kind: "interrupted" } : { error, kind: "failed" },
    )
  const delivery = await racePromiseWithSignal(pendingDelivery, signal)
  if (delivery.kind === "interrupted") {
    throw new ResponsesFrameDeliveryInterrupted(terminal)
  }
  if (delivery.value.kind === "interrupted") {
    throw new ResponsesFrameDeliveryInterrupted(terminal)
  }
  if (delivery.value.kind === "failed") {
    throw new ResponsesFrameDeliveryError(delivery.value.error, terminal)
  }
}

type FrameDeliveryResult =
  | { kind: "delivered" }
  | { error: unknown; kind: "failed" }
  | { kind: "interrupted" }

const normalizeTerminalUsage = (
  event: Extract<
    ResponsesStreamEvent,
    {
      type: "response.completed" | "response.failed" | "response.incomplete"
    }
  >,
): UsageTokens => ({
  ...normalizeResponsesUsage(event.response.usage),
  total_nano_aiu: normalizeResponsesAiu(
    event.copilot_usage,
    event.response.copilot_usage,
  ),
})

const findTimeout = (
  value: unknown,
): UpstreamLifecycleTimeoutError | undefined => {
  let current = value
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof UpstreamLifecycleTimeoutError) return current
    seen.add(current)
    current = current.cause
  }
}

const classifySessionFailure = (
  error: unknown,
  signal: AbortSignal | undefined,
  diagnostics: ResponsesStreamSessionDiagnostics,
):
  | ResponsesStreamSessionAbortOutcome
  | ResponsesStreamSessionThrowOutcome
  | ResponsesStreamSessionTimeoutOutcome => {
  const timeout = findTimeout(error) ?? findTimeout(signal?.reason)
  if (timeout) {
    return {
      diagnostics,
      error: timeout,
      kind: "timeout",
      terminal: null,
    }
  }
  if (signal?.aborted) {
    return {
      diagnostics,
      kind: "abort",
      reason: signal.reason,
      terminal: null,
    }
  }
  return { diagnostics, error, kind: "throw", terminal: null }
}

const setElapsed = (
  diagnostics: ResponsesStreamSessionDiagnostics,
  startedAt: number,
): void => {
  diagnostics.elapsedMs = addSaturatingCounter(0, Date.now() - startedAt)
}

const getSignalOutcome = (
  signal: AbortSignal | undefined,
  diagnostics: ResponsesStreamSessionDiagnostics,
  startedAt: number,
  terminal: ResponsesStreamSessionTerminalSnapshot | null = null,
):
  | ResponsesStreamSessionAbortOutcome
  | ResponsesStreamSessionTimeoutOutcome
  | null => {
  if (!signal?.aborted) return null

  setElapsed(diagnostics, startedAt)
  const timeout = findTimeout(signal.reason)
  if (timeout) {
    return {
      diagnostics,
      error: timeout,
      kind: "timeout",
      terminal,
    }
  }
  return {
    diagnostics,
    kind: "abort",
    reason: signal.reason,
    terminal,
  }
}
