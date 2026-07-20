import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

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

export async function forwardError(
  c: Context,
  error: unknown,
): Promise<Response> {
  const requestBodyErrorResponse = createRequestBodyErrorResponse(c, error)
  if (requestBodyErrorResponse !== null) {
    return requestBodyErrorResponse
  }

  consola.error("Error occurred:", error)

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
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
