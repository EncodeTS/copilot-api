import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

const DEBUG_HEADER_ALLOWLIST = [
  "x-request-id",
  "x-github-request-id",
  "openai-processing-ms",
  "retry-after",
  "content-type",
  "www-authenticate",
]

// Reads the upstream error body once, logs a structured debug line, and returns
// a fresh Response carrying the same body/status/headers so downstream handlers
// (e.g. forwardError) can still consume it.
export async function logUpstreamError(
  label: string,
  response: Response,
  context: Record<string, unknown> = {},
): Promise<Response> {
  const bodyText = await response.text().catch(() => "")
  let parsedBody: unknown = bodyText
  try {
    parsedBody = JSON.parse(bodyText)
  } catch {
    // keep raw text
  }

  const debugHeaders: Record<string, string> = {}
  for (const name of DEBUG_HEADER_ALLOWLIST) {
    const value = response.headers.get(name)
    if (value) debugHeaders[name] = value
  }

  consola.error(`[upstream] ${label} failed`, {
    status: response.status,
    statusText: response.statusText,
    headers: debugHeaders,
    body: parsedBody,
    ...context,
  })

  return new Response(bodyText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    if (error.response.status === 429) {
      for (const [name, value] of error.response.headers) {
        const lowerName = name.toLowerCase()
        if (lowerName === "retry-after" || lowerName.startsWith("x-")) {
          c.header(name, value)
        }
      }
    }

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
