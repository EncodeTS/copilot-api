import { HTTPError } from "~/lib/error"

import type { ResponsesResult } from "~/services/copilot/create-responses"

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
