import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import {
  reportStreamTermination,
  type StreamLifecycleDiagnostics,
} from "~/lib/stream-lifecycle"

export const emitResponsesStreamError = async (
  stream: SSEStreamingApi,
  logger: ConsolaInstance,
  error: unknown,
  context?: {
    diagnostics?: StreamLifecycleDiagnostics
    signal?: AbortSignal
  },
): Promise<void> => {
  const lifecycleError = reportStreamTermination({
    diagnostics: context?.diagnostics ?? {
      elapsedMs: 0,
      eventCount: 0,
      flow: "responses",
      lastEventType: null,
      retryCount: 0,
      terminalSeen: false,
      transport: "unknown",
    },
    error,
    signal: context?.signal,
  })
  if (
    context?.signal?.aborted
    || lifecycleError.kind === "client_abort"
    || lifecycleError.kind === "normal_terminal"
  ) {
    return
  }

  const errorEvent = {
    type: "error",
    code: null,
    message: `Upstream stream ended unexpectedly: ${lifecycleError.message}`,
    param: null,
    sequence_number: 0,
  }

  try {
    await stream.writeSSE({
      event: "error",
      data: JSON.stringify(errorEvent),
    })
  } catch (writeError) {
    logger.warn(
      "Could not write responses stream-error event; client may have disconnected",
      writeError,
    )
  }
}
