import { createHandlerLogger } from "~/lib/logger"
import { HTTPError } from "~/lib/error"
import { UpstreamLifecycleTimeoutError } from "~/lib/upstream-lifecycle"

export type StreamFlow =
  | "chat_completions"
  | "messages"
  | "provider_responses"
  | "responses"

export type StreamTerminationKind =
  | "client_abort"
  | "normal_terminal"
  | "timeout"
  | "upstream_disconnect"

export type StreamTransport = "http" | "unknown" | "websocket"

export interface StreamTerminationClassificationInput {
  error?: unknown
  signal?: AbortSignal
  terminalSeen: boolean
}

export interface StreamLifecycleDiagnostics {
  elapsedMs: number
  eventCount: number
  flow: StreamFlow
  lastEventType: string | null
  retryCount: number
  terminalSeen: boolean
  transport: StreamTransport
}

export interface ReportStreamTerminationInput {
  diagnostics: StreamLifecycleDiagnostics
  error: unknown
  signal?: AbortSignal
}

export interface StreamAttempt<T> {
  open: () => AsyncIterable<T> | Promise<AsyncIterable<T>>
  transport: StreamTransport
}

export interface StreamRetryBudget {
  attempted: boolean
  startedAt: number
}

export interface SuperviseStreamOptions<T> {
  flow: StreamFlow
  getEventType: (event: T) => string | null
  isTerminalEvent: (event: T) => boolean
  primary: StreamAttempt<T>
  retry?: StreamAttempt<T>
  retryBudget?: StreamRetryBudget
  signal?: AbortSignal
}

export const createStreamRetryBudget = (): StreamRetryBudget => ({
  attempted: false,
  startedAt: Date.now(),
})

export class RetryableStreamTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause instanceof Error ? { cause } : undefined)
    this.name = "RetryableStreamTransportError"
  }
}

export class StreamLifecycleError extends Error {
  readonly diagnostics: StreamLifecycleDiagnostics
  readonly errorName: string
  readonly kind: StreamTerminationKind

  constructor({
    diagnostics,
    error,
    kind,
  }: {
    diagnostics: StreamLifecycleDiagnostics
    error: unknown
    kind: StreamTerminationKind
  }) {
    const cause = error instanceof Error ? error : undefined
    super(getErrorMessage(error), cause ? { cause } : undefined)
    this.name = "StreamLifecycleError"
    this.diagnostics = diagnostics
    this.errorName = cause?.name ?? typeof error
    this.kind = kind
  }
}

interface StreamLifecycleLogger {
  debug: (message: string, payload: unknown) => void
  error: (message: string, payload: unknown) => void
  warn: (message: string, payload: unknown) => void
}

const streamLifecycleLogger = createHandlerLogger("stream-lifecycle", {
  mirrorToConsole: process.env.COPILOT_API_TEST_MODE !== "1",
})
const lifecycleErrors = new WeakMap<Error, StreamLifecycleError>()
const reportedLifecycleErrors = new WeakSet<StreamLifecycleError>()

export const classifyStreamTermination = ({
  error,
  signal,
  terminalSeen,
}: StreamTerminationClassificationInput): StreamTerminationKind => {
  if (terminalSeen) return "normal_terminal"
  if (hasTimeout(error) || hasTimeout(signal?.reason)) return "timeout"
  if (signal?.aborted) return "client_abort"
  return "upstream_disconnect"
}

export const reportStreamTermination = (
  input: ReportStreamTerminationInput,
  logger: StreamLifecycleLogger = streamLifecycleLogger,
): StreamLifecycleError => {
  const lifecycleError = getOrCreateStreamLifecycleError(input)
  if (
    lifecycleError.kind === "normal_terminal"
    || reportedLifecycleErrors.has(lifecycleError)
  ) {
    return lifecycleError
  }

  reportedLifecycleErrors.add(lifecycleError)
  const payload = {
    ...lifecycleError.diagnostics,
    kind: lifecycleError.kind,
  }
  if (lifecycleError.kind === "client_abort") {
    logger.debug("stream.lifecycle", payload)
  } else if (lifecycleError.kind === "timeout") {
    logger.warn("stream.lifecycle", payload)
  } else {
    logger.error("stream.lifecycle", payload)
  }
  return lifecycleError
}

export const streamLifecycleDependencies = {
  reportTermination: reportStreamTermination,
}

export const superviseStream = async function* <T>({
  flow,
  getEventType,
  isTerminalEvent,
  primary,
  retry,
  retryBudget = createStreamRetryBudget(),
  signal,
}: SuperviseStreamOptions<T>): AsyncGenerator<T, void, unknown> {
  const startedAt = retryBudget.startedAt
  let eventCount = 0
  let lastEventType: string | null = null
  let terminalSeen = false
  let attempt = primary

  while (true) {
    try {
      const source = await attempt.open()
      for await (const event of source) {
        const eventType = getEventType(event)
        lastEventType = eventType ?? lastEventType
        terminalSeen = isTerminalEvent(event)
        eventCount += 1
        yield event
        if (terminalSeen) return
      }
      throw new RetryableStreamTransportError(
        `${attempt.transport} stream ended without a terminal event`,
      )
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error
      }
      const kind = classifyStreamTermination({
        error,
        signal,
        terminalSeen,
      })
      const shouldRetry =
        error instanceof RetryableStreamTransportError
        && kind === "upstream_disconnect"
        && eventCount === 0
        && !retryBudget.attempted
        && retry !== undefined
      if (shouldRetry) {
        retryBudget.attempted = true
        attempt = retry
        continue
      }

      throw streamLifecycleDependencies.reportTermination({
        diagnostics: {
          elapsedMs: Date.now() - startedAt,
          eventCount,
          flow,
          lastEventType,
          retryCount: retryBudget.attempted ? 1 : 0,
          terminalSeen,
          transport: attempt.transport,
        },
        error,
        signal,
      })
    }
  }
}

const hasTimeout = (value: unknown): boolean => {
  let current = value
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof UpstreamLifecycleTimeoutError) return true
    seen.add(current)
    current = current.cause
  }
  return false
}

const getOrCreateStreamLifecycleError = (
  input: ReportStreamTerminationInput,
): StreamLifecycleError => {
  if (input.error instanceof StreamLifecycleError) return input.error
  if (input.error instanceof Error) {
    const existing = lifecycleErrors.get(input.error)
    if (existing) return existing
  }

  const lifecycleError = new StreamLifecycleError({
    diagnostics: input.diagnostics,
    error: input.error,
    kind: classifyStreamTermination({
      error: input.error,
      signal: input.signal,
      terminalSeen: input.diagnostics.terminalSeen,
    }),
  })
  if (input.error instanceof Error) {
    lifecycleErrors.set(input.error, lifecycleError)
  }
  return lifecycleError
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
