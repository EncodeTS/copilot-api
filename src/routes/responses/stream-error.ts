import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

export const emitResponsesStreamError = async (
  stream: SSEStreamingApi,
  logger: ConsolaInstance,
  error: unknown,
): Promise<void> => {
  const message = formatStreamErrorMessage(error)
  logger.error(`Upstream responses stream failed mid-flight: ${message}`)

  const errorEvent = {
    type: "error",
    code: null,
    message: `Upstream stream ended unexpectedly: ${message}`,
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

const formatStreamErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
