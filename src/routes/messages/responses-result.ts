import { HTTPError } from "~/lib/error"
import type { TokenUsageRecorder } from "~/lib/token-usage"

import type { ResponsesResult } from "~/services/copilot/create-responses"

import {
  BufferedResponsesCollectionLimitError,
  BufferedResponsesTerminalError,
  BufferedResponsesTerminalInterruptionError,
  recordBufferedResponsesTerminalFailure,
  recordBufferedResponsesTerminalInterruption,
} from "./responses-stream-collection"

export const getResponsesResultFailureMessage = (
  result: ResponsesResult,
): string | undefined => {
  const failedStatus =
    result.status === "failed" || result.status === "cancelled"
  if (!failedStatus && !result.error) {
    return undefined
  }

  return (
      typeof result.error?.message === "string"
        && result.error.message.trim().length > 0
    ) ?
      result.error.message
    : `Responses upstream ended with status=${result.status}`
}

export const assertResponsesResultUsable = (result: ResponsesResult): void => {
  const message = getResponsesResultFailureMessage(result)
  if (!message) {
    return
  }

  throw new HTTPError(
    `Responses upstream failed: ${message}`,
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message,
        },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    ),
  )
}

export const createBufferedResponsesProtocolError = (
  error: BufferedResponsesTerminalError,
): HTTPError =>
  new HTTPError(
    error.message,
    new Response(
      JSON.stringify({
        type: "error",
        error: {
          code: error.failure.errorCode,
          type: "api_error",
          message: error.failure.message,
        },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    ),
  )

export const throwRecordedBufferedResponsesError = (
  recordUsage: TokenUsageRecorder,
  error: unknown,
): never => {
  if (error instanceof BufferedResponsesCollectionLimitError && error.record) {
    recordUsage(error.record.usage, error.record.metadata)
    throw error
  }
  if (error instanceof BufferedResponsesTerminalInterruptionError) {
    recordBufferedResponsesTerminalInterruption(recordUsage, error)
    throw error.surfacedError
  }
  if (error instanceof BufferedResponsesTerminalError) {
    recordBufferedResponsesTerminalFailure(recordUsage, error)
    throw createBufferedResponsesProtocolError(error)
  }
  throw error
}
