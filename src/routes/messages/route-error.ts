import { HTTPError } from "~/lib/error"
import {
  PreparedMessagesInvalidRequestError,
  PreparedMessagesUnsupportedModelError,
} from "~/routes/messages/prepared-messages/errors"
import { ResponsesTokenEstimateLimitError } from "~/routes/messages/prepared-messages/token-estimation"

export const adaptMessagesRouteError = (error: unknown): unknown => {
  if (error instanceof PreparedMessagesUnsupportedModelError) {
    return invalidRequestError(
      `The requested model is not supported by the current Copilot model catalog: ${error.model}`,
    )
  }
  if (
    error instanceof PreparedMessagesInvalidRequestError
    || error instanceof ResponsesTokenEstimateLimitError
  ) {
    return invalidRequestError(error.message)
  }
  return error
}

const invalidRequestError = (message: string): HTTPError =>
  new HTTPError(
    message,
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message },
      }),
      {
        headers: { "content-type": "application/json" },
        status: 400,
      },
    ),
  )
