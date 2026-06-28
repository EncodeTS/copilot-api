import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import { buildErrorEvent } from "./responses-stream-translation"

export type StreamFlow = "chat_completions" | "messages" | "responses"

export const emitAnthropicStreamError = async (
  stream: SSEStreamingApi,
  logger: ConsolaInstance,
  ctx: { error: unknown; flow: StreamFlow },
): Promise<void> => {
  const message = formatStreamErrorMessage(ctx.error)
  logger.error(`Upstream ${ctx.flow} stream failed mid-flight: ${message}`)

  const errorEvent = buildErrorEvent(
    `Upstream stream ended unexpectedly: ${message}`,
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

const formatStreamErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
