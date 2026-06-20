import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

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
  consola.error("Error occurred:", error)

  if (error instanceof LocalPayloadTooLargeError) {
    consola.error("Payload budget details:", error.details)
    return c.json(
      {
        error: {
          code: error.code,
          details: error.details,
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
