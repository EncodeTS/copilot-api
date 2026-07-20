import type { MiddlewareHandler } from "hono"

import {
  collectLimitedBody,
  createLimitedBodyStream,
  isAbortError,
} from "~/lib/limited-body"
import {
  createRequestBodyErrorResponse,
  DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES,
  InvalidContentLengthError,
  parseContentLength,
  RequestBodyTooLargeError,
  validateByteLimit,
} from "~/lib/request-body-policy"
import {
  decodeZstdBody as decodeZstdBodyDefault,
  type ZstdDecodeOptions,
  ZstdDecoderUnavailableError,
} from "~/lib/zstd-adapter"

export {
  createRequestBodyErrorResponse,
  DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES,
  InvalidContentLengthError,
  RequestBodyTooLargeError,
  type RequestBodyLimitStage,
} from "~/lib/request-body-policy"

type StreamingRequestInit = RequestInit & { duplex: "half" }

const ZSTD_CONTENT_ENCODING = "zstd"

export interface RequestBodyMiddlewareOptions {
  maxDecodedBytes?: number
  maxEncodedBytes?: number
}

export interface RequestBodyMiddlewareDependencies {
  decodeZstdBody(
    compressed: Uint8Array,
    options: ZstdDecodeOptions,
  ): Promise<Uint8Array>
}

const defaultDependencies: RequestBodyMiddlewareDependencies = {
  decodeZstdBody: decodeZstdBodyDefault,
}

export const createRequestBodyMiddleware = (
  options: RequestBodyMiddlewareOptions = {},
  dependencies: RequestBodyMiddlewareDependencies = defaultDependencies,
): MiddlewareHandler => {
  const maxDecodedBytes = validateByteLimit(
    options.maxDecodedBytes ?? DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES,
    "maxDecodedBytes",
  )
  const maxEncodedBytes = validateByteLimit(
    options.maxEncodedBytes ?? DEFAULT_MAX_LOCAL_REQUEST_BODY_BYTES,
    "maxEncodedBytes",
  )

  return async (c, next) => {
    let contentLength: bigint | null
    try {
      contentLength = parseContentLength(c.req.header("content-length"))
    } catch (error) {
      const response = createRequestBodyErrorResponse(c, error)
      if (response !== null) {
        return response
      }
      throw error
    }
    if (contentLength !== null && contentLength > BigInt(maxEncodedBytes)) {
      return requireRequestBodyErrorResponse(
        c,
        new RequestBodyTooLargeError("encoded"),
      )
    }

    const contentEncoding = normalizeContentEncoding(
      c.req.header("content-encoding"),
    )
    if (contentEncoding === "unsupported") {
      return unsupportedContentEncoding(c)
    }
    if (c.req.raw.body === null) {
      if (contentLength !== null && contentLength !== 0n) {
        return requireRequestBodyErrorResponse(
          c,
          new InvalidContentLengthError(
            "Content-Length does not match the encoded request body.",
          ),
        )
      }
      return contentEncoding === ZSTD_CONTENT_ENCODING ?
          invalidZstdBody(c)
        : await next()
    }

    if (contentEncoding === ZSTD_CONTENT_ENCODING) {
      try {
        const compressed = await collectLimitedBody(c.req.raw.body, {
          expectedBytes: contentLength,
          maxBytes: maxEncodedBytes,
          signal: c.req.raw.signal,
          stage: "encoded",
        })
        const decompressed = await dependencies.decodeZstdBody(compressed, {
          maxDecodedBytes,
          signal: c.req.raw.signal,
        })
        const headers = new Headers(c.req.raw.headers)
        headers.delete("content-encoding")
        headers.delete("content-length")
        replaceRequestBody(c.req, decompressed, headers)
      } catch (error) {
        const requestBodyResponse = createRequestBodyErrorResponse(c, error)
        if (requestBodyResponse !== null) {
          return requestBodyResponse
        }
        if (c.req.raw.signal.aborted || isAbortError(error)) {
          throw error
        }
        if (error instanceof ZstdDecoderUnavailableError) {
          return unsupportedContentEncoding(
            c,
            "Zstd request decompression is unavailable in this runtime.",
          )
        }
        return invalidZstdBody(c)
      }
      return await next()
    }

    if (isMultipart(c.req.header("content-type"))) {
      replaceRequestBody(
        c.req,
        createLimitedBodyStream(c.req.raw.body, {
          expectedBytes: contentLength,
          maxBytes: maxEncodedBytes,
          signal: c.req.raw.signal,
          stage: "encoded",
        }),
      )
      return await next()
    }

    try {
      const body = await collectLimitedBody(c.req.raw.body, {
        expectedBytes: contentLength,
        maxBytes: maxEncodedBytes,
        signal: c.req.raw.signal,
        stage: "encoded",
      })
      replaceRequestBody(c.req, body)
    } catch (error) {
      const requestBodyResponse = createRequestBodyErrorResponse(c, error)
      if (requestBodyResponse !== null) {
        return requestBodyResponse
      }
      throw error
    }
    return await next()
  }
}

export const requestBodyMiddleware = createRequestBodyMiddleware()
export const zstdDecompressionMiddleware = requestBodyMiddleware

const normalizeContentEncoding = (
  value: string | undefined,
): "identity" | "unsupported" | "zstd" => {
  const normalized = value?.trim().toLowerCase()
  if (
    normalized === undefined
    || normalized === ""
    || normalized === "identity"
  ) {
    return "identity"
  }
  return normalized === ZSTD_CONTENT_ENCODING ? "zstd" : "unsupported"
}

const isMultipart = (contentType: string | undefined): boolean =>
  contentType?.trim().toLowerCase().startsWith("multipart/") ?? false

const replaceRequestBody = (
  request: Parameters<MiddlewareHandler>[0]["req"],
  body: ReadableStream<Uint8Array> | Uint8Array,
  headers = request.raw.headers,
): void => {
  request.raw = new Request(request.raw.url, {
    body,
    duplex: "half",
    headers,
    method: request.raw.method,
    signal: request.raw.signal,
  } as StreamingRequestInit)
  request.bodyCache = {}
}

const unsupportedContentEncoding = (
  c: Parameters<MiddlewareHandler>[0],
  message = "Unsupported Content-Encoding header.",
): Response =>
  c.json(
    {
      error: {
        code: "unsupported_content_encoding",
        message,
        type: "invalid_request_error",
      },
    },
    415,
  )

const invalidZstdBody = (c: Parameters<MiddlewareHandler>[0]): Response =>
  c.json(
    {
      error: {
        message: "Failed to decompress zstd request body.",
        type: "invalid_request_error",
      },
    },
    400,
  )

const requireRequestBodyErrorResponse = (
  c: Parameters<MiddlewareHandler>[0],
  error: RequestBodyTooLargeError | InvalidContentLengthError,
): Response => {
  const response = createRequestBodyErrorResponse(c, error)
  if (response === null) {
    throw error
  }
  return response
}
