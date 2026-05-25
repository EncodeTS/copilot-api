import { createHash } from "node:crypto"

import type {
  ResponsesPayload,
  ResponseErrorEvent,
  ResponseStreamEvent,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import { isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled } from "~/lib/config"
import { state } from "~/lib/state"
import {
  createPooledWebSocketStream,
  createWebSocketUrl,
  type PooledWebSocketRequest,
} from "~/services/responses-websocket"
import { requestContext } from "~/lib/request-context"

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api"

type CodexResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
}

type ServerSentEventChunk = {
  data?: string
  event?: string
  id?: number | string
}

type CodexResponsesWebSocketChunk = ServerSentEventChunk

type StandardizedCodexResponsesChunk = {
  chunk: ServerSentEventChunk
  event: ResponseStreamEvent | null
}

interface CodexResponsesStandardStreamOptions {
  onClose?: () => void | Promise<void>
  onChunk?: (chunk: ServerSentEventChunk) => void | Promise<void>
  onEvent?: (event: ResponseStreamEvent) => void | Promise<void>
}

type CodexResponsesWebSocketRequest =
  PooledWebSocketRequest<CodexResponsesWebSocketPayload>

interface CodexResponsesHeaderOptions {
  stream?: boolean | null
}

const STRIPPED_CODEX_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
])

const STRIPPED_CODEX_WEBSOCKET_HEADERS = new Set(["accept", "content-type"])

const CODEX_RESPONSE_STATUSES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "queued",
  "in_progress",
])

type CodexResponseStatus =
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled"
  | "queued"
  | "in_progress"

const requireCodexAuthContext = (): {
  accessToken: string
  accountId: string
} => {
  const accessToken = state.codexAccessToken
  const accountId = state.codexAccountId

  if (!accessToken) {
    throw new Error("Codex access token is not loaded")
  }

  if (!accountId) {
    throw new Error("Codex account id is not loaded")
  }

  return { accessToken, accountId }
}

export function resolveCodexResponsesUrl(
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "")
  if (!normalized) {
    return `${CODEX_API_BASE_URL}/codex/responses`
  }

  if (normalized.endsWith("/codex/responses")) {
    return normalized
  }

  if (normalized.endsWith("/codex")) {
    return `${normalized}/responses`
  }

  return `${normalized}/codex/responses`
}

export function buildCodexResponsesHeaders(
  requestHeaders: Headers,
  options: CodexResponsesHeaderOptions = {},
): Headers {
  const { accessToken, accountId } = requireCodexAuthContext()
  const headers = new Headers()
  for (const [headerName, headerValue] of requestHeaders) {
    const headerNameLower = headerName.toLowerCase()
    if (STRIPPED_CODEX_REQUEST_HEADERS.has(headerNameLower)) {
      continue
    }
    headers.set(headerName, headerValue)
  }

  if (!headers.has("accept")) {
    headers.set(
      "accept",
      options.stream ? "text/event-stream" : "application/json",
    )
  }

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("chatgpt-account-id", accountId)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  if (!headers.has("OpenAI-Beta")) {
    headers.set("OpenAI-Beta", "responses=experimental")
  }
  if (!headers.has("originator")) {
    headers.set("originator", "copilot-api")
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "copilot-api")
  }
  if (headers.get("user-agent")?.startsWith("opencode")) {
    headers.set("originator", "opencode")
    const sessionId = requestContext.getStore()?.sessionAffinity
    if (sessionId) {
      headers.set("session_id", sessionId)
    }
  }
  return headers
}

export function resolveCodexResponsesTransport(
  transport?: ResponsesTransport,
): ResponsesTransport {
  return (
    transport
    ?? (isConfiguredResponsesApiWebSocketEnabled() ? "websocket" : "http")
  )
}

export function buildCodexResponsesWebSocketHeaders(
  requestHeaders: Headers,
): Record<string, string> {
  const headers = buildCodexResponsesHeaders(requestHeaders)
  for (const headerName of STRIPPED_CODEX_WEBSOCKET_HEADERS) {
    headers.delete(headerName)
  }
  return Object.fromEntries(headers)
}

export function buildCodexResponsesWebSocketPayload(
  payload: ResponsesPayload,
): CodexResponsesWebSocketPayload {
  const websocketPayload: CodexResponsesWebSocketPayload = {
    ...payload,
    type: "response.create",
  }

  delete websocketPayload.stream

  return websocketPayload
}

export function buildCodexResponsesWebSocketUrl(
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  return createWebSocketUrl(resolveCodexResponsesUrl(baseUrl))
}

export function prepareCodexResponsesWebSocketRequest(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
): CodexResponsesWebSocketRequest {
  const headers = buildCodexResponsesWebSocketHeaders(requestHeaders)

  return {
    headers,
    payload: buildCodexResponsesWebSocketPayload(payload),
    poolKey: buildCodexResponsesWebSocketPoolKey(payload, headers, baseUrl),
    url: buildCodexResponsesWebSocketUrl(baseUrl),
  }
}

export async function forwardCodexResponses(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
  options: {
    transport?: ResponsesTransport
  } = {},
): Promise<Response> {
  const normalizedPayload: ResponsesPayload = {
    ...payload,
    store: false,
    temperature: undefined,
    top_p: undefined,
    max_output_tokens: undefined,
    metadata: undefined,
  }

  if (
    normalizedPayload.stream
    && resolveCodexResponsesTransport(options.transport) === "websocket"
  ) {
    return forwardCodexResponsesOverWebSocket(
      normalizedPayload,
      requestHeaders,
      baseUrl,
    )
  }

  return await fetch(resolveCodexResponsesUrl(baseUrl), {
    method: "POST",
    headers: buildCodexResponsesHeaders(requestHeaders, {
      stream: normalizedPayload.stream,
    }),
    body: JSON.stringify(normalizedPayload),
  })
}

const buildCodexResponsesWebSocketPoolKey = (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  baseUrl: string,
): string => {
  const authFingerprint = createHash("sha256")
    .update(
      `${state.codexAccessToken ?? "missing-token"}:${state.codexAccountId ?? "missing-account"}`,
    )
    .digest("hex")
    .slice(0, 16)
  const headerFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(headers).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    )
    .digest("hex")
    .slice(0, 16)

  return [
    "codex",
    resolveCodexResponsesUrl(baseUrl),
    payload.model,
    authFingerprint,
    headerFingerprint,
  ]
    .map(encodePoolKeyPart)
    .join("|")
}

const forwardCodexResponsesOverWebSocket = (
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string,
): Response => {
  const websocketRequest = prepareCodexResponsesWebSocketRequest(
    payload,
    requestHeaders,
    baseUrl,
  )
  const stream = createCodexResponsesWebSocketStream(websocketRequest)

  return createCodexResponsesWebSocketProxyResponse(stream)
}

const createCodexResponsesWebSocketStream = (
  request: CodexResponsesWebSocketRequest,
): AsyncIterable<CodexResponsesWebSocketChunk> =>
  createPooledWebSocketStream(request, {
    createChunk: createCodexResponsesWebSocketStreamChunk,
    isTerminalChunk: isTerminalCodexResponsesWebSocketChunk,
    openErrorMessage: "Failed to create codex responses websocket",
    streamErrorMessage: "Codex responses websocket stream error",
    terminalChunkMissingMessage:
      "Codex responses websocket ended without a terminal response",
  })

const createCodexResponsesWebSocketStreamChunk = (
  data: string,
): CodexResponsesWebSocketChunk => {
  if (data === "[DONE]") {
    return { data }
  }

  try {
    const parsed = JSON.parse(data) as {
      id?: unknown
      type?: unknown
    }

    return {
      data: JSON.stringify(parsed),
      event: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : undefined,
    }
  } catch {
    return { data }
  }
}

const isTerminalCodexResponsesWebSocketChunk = (
  chunk: CodexResponsesWebSocketChunk,
): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    return (
      parsed.type === "response.completed"
      || parsed.type === "response.done"
      || parsed.type === "response.failed"
      || parsed.type === "response.incomplete"
      || parsed.type === "error"
    )
  } catch {
    return false
  }
}

const createCodexResponsesWebSocketProxyResponse = (
  stream: AsyncIterable<CodexResponsesWebSocketChunk>,
): Response => {
  return new Response(
    createServerSentEventStream(normalizeCodexResponsesWebSocketStream(stream)),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      },
      status: 200,
    },
  )
}

export const createStandardizedCodexResponsesEventStream = (
  source: AsyncIterable<ServerSentEventChunk>,
  options: CodexResponsesStandardStreamOptions = {},
): ReadableStream<Uint8Array> => {
  return createServerSentEventStream(
    normalizeCodexResponsesStandardStream(source, options),
  )
}

const normalizeCodexResponsesWebSocketStream = async function* (
  stream: AsyncIterable<CodexResponsesWebSocketChunk>,
): AsyncIterable<CodexResponsesWebSocketChunk> {
  for await (const chunk of stream) {
    yield normalizeCodexResponsesProxyChunk(chunk)
  }
}

const normalizeCodexResponsesStandardStream = async function* (
  stream: AsyncIterable<ServerSentEventChunk>,
  options: CodexResponsesStandardStreamOptions,
): AsyncIterable<ServerSentEventChunk> {
  try {
    for await (const chunk of stream) {
      const normalized = normalizeCodexResponsesStandardChunk(chunk)
      await options.onChunk?.(normalized.chunk)
      if (normalized.event) {
        await options.onEvent?.(normalized.event)
      }

      yield normalized.chunk
    }
  } finally {
    await options.onClose?.()
  }
}

const normalizeCodexResponsesProxyChunk = (
  chunk: CodexResponsesWebSocketChunk,
): CodexResponsesWebSocketChunk => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return chunk
  }

  try {
    const parsed = JSON.parse(chunk.data) as { type?: unknown }
    if (parsed.type !== "response.completed") {
      return chunk
    }

    return {
      ...chunk,
      data: JSON.stringify({
        ...parsed,
        type: "response.done",
      }),
      event: "response.done",
    }
  } catch {
    return chunk
  }
}

const normalizeCodexResponsesStandardChunk = (
  chunk: ServerSentEventChunk,
): StandardizedCodexResponsesChunk => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return {
      chunk,
      event: null,
    }
  }

  try {
    const parsed = JSON.parse(chunk.data) as Record<string, unknown>
    logCodexRateLimitsEvent(parsed)
    const normalized = normalizeCodexResponsesEvent(parsed)
    if (!normalized) {
      return {
        chunk,
        event: null,
      }
    }

    return {
      chunk: {
        ...chunk,
        data: JSON.stringify(normalized),
        event: normalized.type,
      },
      event: normalized,
    }
  } catch {
    return {
      chunk,
      event: null,
    }
  }
}

const createServerSentEventStream = (
  source: AsyncIterable<ServerSentEventChunk>,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const iterator = source[Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    async cancel() {
      await iterator.return?.()
    },
    async pull(controller) {
      try {
        const result: IteratorResult<ServerSentEventChunk> =
          await iterator.next()
        if (result.done) {
          controller.close()
          return
        }

        controller.enqueue(
          encoder.encode(serializeServerSentEvent(result.value)),
        )
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            serializeServerSentEvent(
              createResponsesErrorServerSentEventChunk(getErrorMessage(error)),
            ),
          ),
        )
        controller.close()
      }
    },
  })
}

const createResponsesErrorServerSentEventChunk = (
  message: string,
): ServerSentEventChunk => {
  const errorEvent: ResponseErrorEvent = {
    code: null,
    message,
    param: null,
    sequence_number: 0,
    type: "error",
  }

  return {
    data: JSON.stringify(errorEvent),
    event: errorEvent.type,
  }
}

const serializeServerSentEvent = (chunk: ServerSentEventChunk): string => {
  const lines: Array<string> = []

  if (chunk.id) {
    lines.push(`id: ${chunk.id}`)
  }

  if (chunk.event) {
    lines.push(`event: ${chunk.event}`)
  }

  if (chunk.data !== undefined) {
    for (const line of String(chunk.data).split(/\r?\n/u)) {
      lines.push(`data: ${line}`)
    }
  }

  return `${lines.join("\n")}\n\n`
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}

const encodePoolKeyPart = (value: string): string => encodeURIComponent(value)

function normalizeCodexResponseStatus(
  status: unknown,
): CodexResponseStatus | undefined {
  return typeof status === "string" && CODEX_RESPONSE_STATUSES.has(status) ?
      (status as CodexResponseStatus)
    : undefined
}

function normalizeCodexResponseRecord(
  eventRecord: Record<string, unknown>,
): Record<string, unknown> {
  const response = eventRecord.response
  if (!response || typeof response !== "object") {
    return eventRecord
  }

  const normalizedStatus = normalizeCodexResponseStatus(
    (response as { status?: unknown }).status,
  )
  if (!normalizedStatus) {
    return eventRecord
  }

  return {
    ...eventRecord,
    response: {
      ...response,
      status: normalizedStatus,
    },
  }
}

export function normalizeCodexResponsesEvent(
  event: unknown,
): ResponseStreamEvent | null {
  if (!event || typeof event !== "object") {
    return null
  }

  const eventRecord = normalizeCodexResponseRecord(
    event as Record<string, unknown>,
  )
  const type = eventRecord.type
  if (typeof type !== "string") {
    return null
  }

  if (type === "response.done") {
    return {
      ...eventRecord,
      type: "response.completed",
    } as ResponseStreamEvent
  }

  return eventRecord as unknown as ResponseStreamEvent
}
