import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

import { AuthRequestError } from "~/lib/auth-request"
import { getUpstreamResponseMetadataHeaders } from "./upstream-response-headers"
import { createRequestBodyErrorResponse } from "~/lib/request-body-policy"
export interface LocalPayloadTooLargeDetails {
  payloadBytes: number
  budgetBytes: number
  sendHardLimitBytes: number
  bodyBytesOverBudget?: number
  candidateCount?: number
  compressionActionLimit?: number
  compressionActionLimitHit?: boolean
  compressionAttemptedCount?: number
  compressionCacheHitCount?: number
  compressionDiagnosticCounts?: Partial<Record<string, number>>
  compressionDiagnosticSamples?: Array<object>
  compressionNegativeCacheHitCount?: number
  compressionProfiles?: Array<{
    compressedCount: number
    attemptedCount: number
    profile: string
    statusCounts?: Record<string, number>
  }>
  compressionStatusCounts?: Record<string, number>
  compressedCount?: number
  imageBytes: number
  fileDataBytes: number
  hardLimitMet?: boolean
  largestImageBytes?: number
  largestUnoptimizableKind?: string
  oversizedInputImageCount?: number
  oversizedResolvedCount?: number
  preservedLatestCount?: number
  targetMet?: boolean
  textAndToolBytes: number
  imageCount: number
  replacedCount: number
  latestImageReplaced: boolean
  currentVisualWorkingSetReplaced: boolean
  unresolvedReason?: string
}

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class LocalPayloadTooLargeError extends Error {
  code = "responses_payload_too_large"
  details: LocalPayloadTooLargeDetails

  constructor(message: string, details: LocalPayloadTooLargeDetails) {
    super(message)
    this.details = details
  }
}

/**
 * Renders a client-safe message for a value that reached the terminal error
 * branch. Non-`Error` throws are real here — `rejectWithAbortReason` in
 * `tokenizer-worker-client.ts` deliberately preserves a non-`Error`
 * `AbortSignal.reason` identity — and `(error as Error).message` would send
 * `undefined` to the client for those. Objects are rendered via `String`
 * rather than serialized so a thrown payload cannot leak into the response.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || "Unknown error"
  }

  try {
    return String(error) || "Unknown error"
  } catch {
    // Null-prototype objects and similar values have no primitive conversion.
    return "Unknown error"
  }
}

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  const requestBodyErrorResponse = createRequestBodyErrorResponse(c, error)
  if (requestBodyErrorResponse !== null) {
    return requestBodyErrorResponse
  }

  if (error instanceof AuthRequestError) {
    consola.error("Auth request failed:", error.message)
  } else {
    consola.error("Error occurred:", error)
  }

  if (error instanceof LocalPayloadTooLargeError) {
    consola.error("Payload budget details:", error.details)
    const clientDetails = {
      ...error.details,
      compressionDiagnosticSamples:
        error.details.compressionDiagnosticSamples?.map((sample) => {
          const sanitized: Record<string, unknown> = { ...sample }
          delete sanitized.stack
          return sanitized
        }),
    }
    return c.json(
      {
        error: {
          code: error.code,
          details: clientDetails,
          message: error.message,
          type: "payload_too_large",
        },
      },
      413,
    )
  }

  if (error instanceof AuthRequestError) {
    for (const [name, value] of Object.entries(error.headers)) {
      c.header(name, value)
    }
    return c.json(
      {
        error: {
          message: error.message,
          type: "auth_error",
        },
      },
      error.downstreamStatus as ContentfulStatusCode,
    )
  }

  if (error instanceof HTTPError) {
    for (const [name, value] of Object.entries(
      getUpstreamResponseMetadataHeaders(error.response.headers),
    )) {
      c.header(name, value)
    }

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)

    if (typeof errorJson === "object" && errorJson !== null) {
      c.header(
        "content-type",
        error.response.headers.get("content-type") ?? "application/json",
      )
      return c.body(errorText, error.response.status as ContentfulStatusCode)
    }

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
        message: describeError(error),
        type: "error",
      },
    },
    500,
  )
}
