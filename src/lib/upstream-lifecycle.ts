export type UpstreamFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export const DEFAULT_UPSTREAM_HTTP_HEADERS_TIMEOUT_MS = 120_000

export interface UpstreamLifecycleTimeouts {
  httpHeadersMs?: number
  httpFirstByteMs?: number
  httpInactivityMs?: number
  httpTotalMs?: number
  websocketConnectMs?: number
  websocketFirstFrameMs?: number
  websocketInactivityMs?: number
  websocketTotalMs?: number
}

export const DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS = {
  httpHeadersMs: DEFAULT_UPSTREAM_HTTP_HEADERS_TIMEOUT_MS,
  httpFirstByteMs: 120_000,
  httpInactivityMs: 300_000,
  httpTotalMs: 3_600_000,
  websocketConnectMs: 30_000,
  websocketFirstFrameMs: 120_000,
  websocketInactivityMs: 300_000,
  websocketTotalMs: 3_600_000,
} as const satisfies Required<UpstreamLifecycleTimeouts>

export const resolveUpstreamLifecycleTimeouts = (
  timeouts: UpstreamLifecycleTimeouts | undefined,
): Required<UpstreamLifecycleTimeouts> => ({
  httpHeadersMs: normalizeTimeoutMs(
    timeouts?.httpHeadersMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.httpHeadersMs,
  ),
  httpFirstByteMs: normalizeTimeoutMs(
    timeouts?.httpFirstByteMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.httpFirstByteMs,
  ),
  httpInactivityMs: normalizeTimeoutMs(
    timeouts?.httpInactivityMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.httpInactivityMs,
  ),
  httpTotalMs: normalizeTimeoutMs(
    timeouts?.httpTotalMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.httpTotalMs,
  ),
  websocketConnectMs: normalizeTimeoutMs(
    timeouts?.websocketConnectMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.websocketConnectMs,
  ),
  websocketFirstFrameMs: normalizeTimeoutMs(
    timeouts?.websocketFirstFrameMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.websocketFirstFrameMs,
  ),
  websocketInactivityMs: normalizeTimeoutMs(
    timeouts?.websocketInactivityMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.websocketInactivityMs,
  ),
  websocketTotalMs: normalizeTimeoutMs(
    timeouts?.websocketTotalMs,
    DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS.websocketTotalMs,
  ),
})

export class UpstreamLifecycleTimeoutError extends Error {
  readonly phase: string
  readonly timeoutMs: number

  constructor(phase: string, timeoutMs: number) {
    super(`Upstream ${phase} timed out after ${timeoutMs}ms`)
    this.name = "UpstreamLifecycleTimeoutError"
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export interface UpstreamHttpLifecycleOptions {
  fetcher?: UpstreamFetch
  headersTimeoutMs?: number
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
}

const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  timer.unref?.()
}

export const upstreamLifecycleDependencies = {
  unrefTimer,
}

export const fetchWithUpstreamLifecycle = async (
  input: string | URL | Request,
  init: RequestInit,
  options: UpstreamHttpLifecycleOptions = {},
): Promise<Response> => {
  const requestController = new AbortController()
  const timeouts = resolveUpstreamLifecycleTimeouts(options.timeouts)
  const headersTimeoutMs = normalizeTimeoutMs(
    options.headersTimeoutMs,
    timeouts.httpHeadersMs,
  )
  const timer = setTimeout(() => {
    requestController.abort(
      new UpstreamLifecycleTimeoutError("HTTP headers", headersTimeoutMs),
    )
  }, headersTimeoutMs)
  upstreamLifecycleDependencies.unrefTimer(timer)
  const signals = [
    requestController.signal,
    init.signal,
    options.signal,
  ].filter((signal): signal is AbortSignal => signal != null)
  const signal = AbortSignal.any(signals)

  let response: Response
  try {
    response = await (options.fetcher ?? fetch)(input, {
      ...init,
      signal,
    })
  } finally {
    clearTimeout(timer)
  }

  return wrapResponseBodyWithLifecycle(response, {
    requestController,
    signal,
    timeouts,
  })
}

const wrapResponseBodyWithLifecycle = (
  response: Response,
  lifecycle: {
    requestController: AbortController
    signal: AbortSignal
    timeouts: Required<UpstreamLifecycleTimeouts>
  },
): Response => {
  if (!response.body) {
    return response
  }

  const reader = response.body.getReader() as ByteStreamReader
  const startedAt = Date.now()
  let closed = false
  let receivedByte = false

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        return
      }

      const totalElapsedMs = Date.now() - startedAt
      const activityTimeoutMs =
        receivedByte ?
          lifecycle.timeouts.httpInactivityMs
        : lifecycle.timeouts.httpFirstByteMs
      const activityPhase = receivedByte ? "HTTP inactivity" : "HTTP first byte"
      const totalRemainingMs = lifecycle.timeouts.httpTotalMs - totalElapsedMs
      const totalExpiresFirst = totalRemainingMs <= activityTimeoutMs
      const phase = totalExpiresFirst ? "HTTP total" : activityPhase
      const reportedTimeoutMs =
        totalExpiresFirst ? lifecycle.timeouts.httpTotalMs : activityTimeoutMs

      try {
        const result = await readWithLifecycle(reader, {
          phase,
          reportedTimeoutMs,
          requestController: lifecycle.requestController,
          signal: lifecycle.signal,
          timeoutMs: Math.max(1, Math.min(activityTimeoutMs, totalRemainingMs)),
        })
        if (result.done) {
          closed = true
          controller.close()
          return
        }

        receivedByte = true
        controller.enqueue(result.value)
      } catch (error) {
        closed = true
        lifecycle.requestController.abort(error)
        await reader.cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    async cancel(reason) {
      closed = true
      lifecycle.requestController.abort(reason)
      await reader.cancel(reason).catch(() => {})
    },
  })

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const readWithLifecycle = async (
  reader: ByteStreamReader,
  options: {
    phase: string
    reportedTimeoutMs: number
    requestController: AbortController
    signal: AbortSignal
    timeoutMs: number
  },
): Promise<ByteStreamReadResult> =>
  await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      const error = new UpstreamLifecycleTimeoutError(
        options.phase,
        options.reportedTimeoutMs,
      )
      options.requestController.abort(error)
      settle(() => reject(error))
    }, options.timeoutMs)
    upstreamLifecycleDependencies.unrefTimer(timer)

    const cleanup = () => {
      clearTimeout(timer)
      options.signal.removeEventListener("abort", onAbort)
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
      settle(() => reject(toAbortError(options.signal.reason)))

    if (options.signal.aborted) {
      onAbort()
      return
    }
    options.signal.addEventListener("abort", onAbort, { once: true })
    reader.read().then(
      (result) => settle(() => resolve(result)),
      (error: unknown) => settle(() => reject(toAbortError(error))),
    )
  })

const toAbortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    return reason
  }
  if (
    typeof reason === "string"
    || typeof reason === "number"
    || typeof reason === "boolean"
  ) {
    return new Error(String(reason))
  }
  return new Error("Upstream request aborted")
}

interface ByteStreamReadResult {
  done: boolean
  value?: Uint8Array
}

interface ByteStreamReader {
  cancel(reason?: unknown): Promise<void>
  read(): Promise<ByteStreamReadResult>
}

const normalizeTimeoutMs = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ?
    Math.floor(value)
  : fallback
