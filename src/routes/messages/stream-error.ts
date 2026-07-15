import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import {
  reportStreamTermination,
  type StreamFlow,
  type StreamLifecycleDiagnostics,
} from "~/lib/stream-lifecycle"

import { buildErrorEvent } from "./responses-stream-translation"

export const emitAnthropicStreamError = async (
  stream: SSEStreamingApi,
  logger: ConsolaInstance,
  ctx: {
    diagnostics?: StreamLifecycleDiagnostics
    error: unknown
    flow: StreamFlow
    signal?: AbortSignal
  },
): Promise<void> => {
  const lifecycleError = reportStreamTermination({
    diagnostics: ctx.diagnostics ?? {
      elapsedMs: 0,
      eventCount: 0,
      flow: ctx.flow,
      lastEventType: null,
      retryCount: 0,
      terminalSeen: false,
      transport: "unknown",
    },
    error: ctx.error,
    signal: ctx.signal,
  })
  if (
    ctx.signal?.aborted
    || lifecycleError.kind === "client_abort"
    || lifecycleError.kind === "normal_terminal"
  ) {
    return
  }

  const errorEvent = buildErrorEvent(
    `Upstream stream ended unexpectedly: ${lifecycleError.message}`,
  )

  try {
    await stream.writeSSE({
      event: errorEvent.type,
      data: JSON.stringify(errorEvent),
    })
  } catch (writeError) {
    logger.warn(
      "Could not write stream-error event; client may have disconnected",
      writeError,
    )
  }
}
