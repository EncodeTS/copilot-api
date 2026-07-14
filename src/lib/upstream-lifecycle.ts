export type UpstreamFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export const DEFAULT_UPSTREAM_HTTP_HEADERS_TIMEOUT_MS = 120_000

export interface UpstreamLifecycleTimeouts {
  httpHeadersMs?: number
  websocketConnectMs?: number
  websocketFirstFrameMs?: number
  websocketInactivityMs?: number
  websocketTotalMs?: number
}

export const DEFAULT_UPSTREAM_LIFECYCLE_TIMEOUTS = {
  httpHeadersMs: DEFAULT_UPSTREAM_HTTP_HEADERS_TIMEOUT_MS,
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
}

export const fetchWithUpstreamLifecycle = async (
  input: string | URL | Request,
  init: RequestInit,
  options: UpstreamHttpLifecycleOptions = {},
): Promise<Response> => {
  const headersController = new AbortController()
  const headersTimeoutMs = normalizeTimeoutMs(
    options.headersTimeoutMs,
    DEFAULT_UPSTREAM_HTTP_HEADERS_TIMEOUT_MS,
  )
  const timer = setTimeout(() => {
    headersController.abort(
      new UpstreamLifecycleTimeoutError("HTTP headers", headersTimeoutMs),
    )
  }, headersTimeoutMs)
  timer.unref?.()
  const signals = [
    headersController.signal,
    init.signal,
    options.signal,
  ].filter((signal): signal is AbortSignal => signal !== undefined)
  const signal = AbortSignal.any(signals)

  try {
    return await (options.fetcher ?? fetch)(input, {
      ...init,
      signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

const normalizeTimeoutMs = (
  value: number | undefined,
  fallback: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ?
    Math.floor(value)
  : fallback
