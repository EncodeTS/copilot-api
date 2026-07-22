export const DEFAULT_AUTH_REQUEST_TIMEOUT_MS = 15_000
export const DEFAULT_AUTH_RESPONSE_BODY_LIMIT_BYTES = 1024 * 1024

export type AuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export interface AuthRequestOptions {
  fetch?: AuthFetch
  signal?: AbortSignal
  timeoutMs?: number
}

export interface FetchAuthJsonOptions extends AuthRequestOptions {
  action: string
  maxBodyBytes?: number
}

export interface AuthJsonResponse {
  headers: Readonly<Record<string, string>>
  jsonValid: boolean
  ok: boolean
  payload: unknown
  status: number
}

export type AuthRetryDisposition = "permanent" | "retryable"

const SAFE_OAUTH_CODES = new Set([
  "access_denied",
  "authorization_pending",
  "device_flow_disabled",
  "expired_token",
  "incorrect_client_credentials",
  "invalid_client",
  "invalid_grant",
  "invalid_request",
  "server_error",
  "slow_down",
  "temporarily_unavailable",
  "unauthorized_client",
  "unsupported_grant_type",
])

const RETRYABLE_OAUTH_CODES = new Set([
  "authorization_pending",
  "server_error",
  "slow_down",
  "temporarily_unavailable",
])

const UNAUTHORIZED_OAUTH_CODES = new Set([
  "incorrect_client_credentials",
  "invalid_client",
  "invalid_grant",
])

const SAFE_RESPONSE_HEADERS = new Set([
  "retry-after",
  "x-github-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
])

export class AuthRequestError extends Error {
  readonly downstreamStatus: number
  readonly headers: Readonly<Record<string, string>>
  readonly kind: AuthRetryDisposition
  readonly oauthCode?: string
  readonly upstreamStatus: number

  constructor(options: {
    action: string
    headers?: Readonly<Record<string, string>>
    kind: AuthRetryDisposition
    oauthCode?: string
    status: number
    downstreamStatus?: number
  }) {
    const oauthCode =
      options.oauthCode && SAFE_OAUTH_CODES.has(options.oauthCode) ?
        options.oauthCode
      : undefined
    const downstreamStatus =
      options.downstreamStatus
      ?? getAuthDownstreamStatus(options.status, oauthCode, options.kind)
    const suffix = oauthCode ? `: ${oauthCode}` : ""
    super(`${options.action} failed (${downstreamStatus})${suffix}`)
    this.name = "AuthRequestError"
    this.headers = Object.freeze({ ...(options.headers ?? {}) })
    this.kind = options.kind
    this.oauthCode = oauthCode
    this.upstreamStatus = options.status
    this.downstreamStatus = downstreamStatus
  }
}

export class AuthProtocolError extends Error {
  readonly retryDisposition: AuthRetryDisposition

  constructor(
    message: string,
    retryDisposition: AuthRetryDisposition = "permanent",
  ) {
    super(message)
    this.name = "AuthProtocolError"
    this.retryDisposition = retryDisposition
  }
}

export class AuthTransportError extends Error {
  readonly kind: "aborted" | "retryable" | "timeout"

  constructor(message: string, kind: "aborted" | "retryable" | "timeout") {
    super(message)
    this.name = "AuthTransportError"
    this.kind = kind
  }
}

function assertFinitePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive finite number`)
  }
}

function sanitizeHeaders(headers: Headers): Readonly<Record<string, string>> {
  const sanitized: Record<string, string> = {}
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase()
    if (SAFE_RESPONSE_HEADERS.has(normalizedName)) {
      sanitized[normalizedName] = value
    }
  }
  return Object.freeze(sanitized)
}

async function readBoundedBody(options: {
  action: string
  maxBodyBytes: number
  response: Response
  signal: AbortSignal
}): Promise<Uint8Array> {
  const body = options.response.body
  if (!body) return new Uint8Array()

  const reader = (body as ReadableStream<Uint8Array>).getReader()
  const chunks: Array<Uint8Array> = []
  let totalBytes = 0
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined)
  }
  if (options.signal.aborted) {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    const error = new Error(`${options.action} body read was aborted`)
    error.name = "AbortError"
    throw error
  }
  options.signal.addEventListener("abort", cancelReader, { once: true })

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > options.maxBodyBytes) {
        await reader.cancel().catch(() => undefined)
        throw new AuthProtocolError(
          `${options.action} response exceeded the safe body limit`,
          getAuthRetryDisposition(options.response.status),
        )
      }
      chunks.push(value)
    }
  } finally {
    options.signal.removeEventListener("abort", cancelReader)
    reader.releaseLock()
  }

  const bodyBytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bodyBytes
}

function parseJsonBody(body: Uint8Array): {
  jsonValid: boolean
  payload: unknown
} {
  if (body.byteLength === 0) {
    return { jsonValid: false, payload: undefined }
  }
  try {
    return {
      jsonValid: true,
      payload: JSON.parse(new TextDecoder().decode(body)) as unknown,
    }
  } catch {
    return { jsonValid: false, payload: undefined }
  }
}

export async function fetchAuthJson(
  input: string | URL | Request,
  init: RequestInit,
  options: FetchAuthJsonOptions,
): Promise<AuthJsonResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTH_REQUEST_TIMEOUT_MS
  const maxBodyBytes =
    options.maxBodyBytes ?? DEFAULT_AUTH_RESPONSE_BODY_LIMIT_BYTES
  assertFinitePositive(timeoutMs, "Auth request timeout")
  assertFinitePositive(maxBodyBytes, "Auth response body limit")

  if (options.signal?.aborted) {
    throw new AuthTransportError(`${options.action} was aborted`, "aborted")
  }

  const controller = new AbortController()
  let timedOut = false
  const onCallerAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onCallerAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timeout.unref?.()
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("auth-request-aborted")),
      { once: true },
    )
  })

  try {
    const fetcher: AuthFetch = options.fetch ?? globalThis.fetch
    const operation = async (): Promise<AuthJsonResponse> => {
      const response = await fetcher(input, {
        ...init,
        signal: controller.signal,
      })
      const body = await readBoundedBody({
        action: options.action,
        maxBodyBytes,
        response,
        signal: controller.signal,
      })
      return {
        ...parseJsonBody(body),
        headers: sanitizeHeaders(response.headers),
        ok: response.ok,
        status: response.status,
      }
    }
    return await Promise.race([operation(), aborted])
  } catch (error) {
    if (timedOut) {
      throw new AuthTransportError(
        `${options.action} timed out after ${timeoutMs}ms`,
        "timeout",
      )
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new AuthTransportError(`${options.action} was aborted`, "aborted")
    }
    if (
      error instanceof AuthProtocolError
      || error instanceof AuthRequestError
    ) {
      throw error
    }
    throw new AuthTransportError(
      `${options.action} failed because of a network error`,
      "retryable",
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onCallerAbort)
  }
}

export function readOAuthErrorCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const code = (payload as { error?: unknown }).error
  return typeof code === "string" && SAFE_OAUTH_CODES.has(code) ?
      code
    : undefined
}

export function requireAuthObject(
  response: Pick<AuthJsonResponse, "jsonValid" | "payload">,
  action: string,
): Record<string, unknown> {
  if (
    !response.jsonValid
    || !response.payload
    || typeof response.payload !== "object"
    || Array.isArray(response.payload)
  ) {
    throw new AuthProtocolError(`${action} response is not valid JSON`)
  }
  return response.payload as Record<string, unknown>
}

export function createAuthRequestError(options: {
  action: string
  headers?: Readonly<Record<string, string>>
  oauthCode?: string
  status: number
}): AuthRequestError {
  return new AuthRequestError({
    ...options,
    kind: getAuthRetryDisposition(options.status, options.oauthCode),
  })
}

function getAuthDownstreamStatus(
  upstreamStatus: number,
  oauthCode: string | undefined,
  kind: AuthRetryDisposition,
): number {
  if (upstreamStatus < 200 || upstreamStatus >= 300) return upstreamStatus
  if (kind === "retryable") return 502
  return oauthCode && UNAUTHORIZED_OAUTH_CODES.has(oauthCode) ? 401 : 400
}

export function getAuthRetryDisposition(
  status: number,
  oauthCode?: string,
): AuthRetryDisposition {
  return (
      status === 408
        || status === 425
        || status === 429
        || status >= 500
        || (oauthCode !== undefined && RETRYABLE_OAUTH_CODES.has(oauthCode))
    ) ?
      "retryable"
    : "permanent"
}

export function isRetryableAuthError(error: unknown): boolean {
  return (
    (error instanceof AuthRequestError && error.kind === "retryable")
    || (error instanceof AuthProtocolError
      && error.retryDisposition === "retryable")
    || (error instanceof AuthTransportError
      && (error.kind === "retryable" || error.kind === "timeout"))
  )
}
