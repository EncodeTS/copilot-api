import type { Context } from "hono"

export type RequestBodyLimitStage = "decoded" | "encoded"

export const DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES = 64 * 1024 * 1024

export class RequestBodyTooLargeError extends Error {
  stage: RequestBodyLimitStage

  constructor(stage: RequestBodyLimitStage) {
    super(`${stage} request body exceeds the local safety limit`)
    this.name = "RequestBodyTooLargeError"
    this.stage = stage
  }
}

export class InvalidContentLengthError extends Error {
  constructor(message = "Invalid Content-Length header.") {
    super(message)
    this.name = "InvalidContentLengthError"
  }
}

export const validateByteLimit = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

export const parseContentLength = (
  value: string | undefined,
): bigint | null => {
  if (value === undefined) {
    return null
  }

  const normalized = value.trim()
  if (!/^\d+$/.test(normalized)) {
    throw new InvalidContentLengthError()
  }
  return BigInt(normalized)
}

export const createRequestBodyErrorResponse = (
  c: Context,
  error: unknown,
): Response | null => {
  if (error instanceof RequestBodyTooLargeError) {
    return c.json(
      {
        error: {
          code: "local_request_body_too_large",
          message:
            error.stage === "encoded" ?
              "Encoded request body exceeds the local safety limit."
            : "Decompressed request body exceeds the local safety limit.",
          stage: error.stage,
          type: "payload_too_large",
        },
      },
      413,
    )
  }

  if (error instanceof InvalidContentLengthError) {
    return c.json(
      {
        error: {
          code: "invalid_content_length",
          message: error.message,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  return null
}
