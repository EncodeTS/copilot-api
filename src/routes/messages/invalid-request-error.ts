import { HTTPError } from "~/lib/error"

export const createMessagesInvalidRequestError = (message: string): HTTPError =>
  new HTTPError(
    message,
    new Response(
      JSON.stringify({
        error: {
          message,
          type: "invalid_request_error",
        },
      }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    ),
  )
