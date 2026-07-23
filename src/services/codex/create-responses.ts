import { createHash } from "node:crypto"

import { events, type ServerSentEventMessage } from "fetch-event-stream"

import type {
  CreateResponsesReturn,
  ResponseInputContent,
  ResponseInputItem,
  ResponseInputMessage,
  ResponsesPayload,
  ResponseErrorEvent,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import {
  getResponsesWebSocketResourceLimits,
  isResponsesApiWebSocketEnabled as isConfiguredResponsesApiWebSocketEnabled,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { isResponsesStreamTerminalData } from "~/lib/responses-stream-protocol"
import {
  fetchWithUpstreamLifecycle,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import { state } from "~/lib/state"
import {
  createPooledWebSocketIdentity,
  createPooledWebSocketStream,
  createWebSocketUrl,
  isWebSocketSentUnknownError,
  type PooledWebSocketRequest,
} from "~/services/responses-websocket"
import { projectResponsesWebSocketChunk } from "~/services/responses-websocket-chunk"
import {
  degradeResponsesWebSocketTransport,
  shouldPreferResponsesHttpTransport,
} from "~/services/copilot/responses-transport-health"
import { requestContext } from "~/lib/request-context"
import consola from "consola"

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api"

type CodexResponsesWebSocketPayload = ResponsesPayload & {
  type: "response.create"
}

type ServerSentEventChunk = ServerSentEventMessage

type CodexResponsesWebSocketRequest =
  PooledWebSocketRequest<CodexResponsesWebSocketPayload>

export type CodexResponsesDispatch =
  | {
      kind: "http"
      payload: ResponsesPayload
      response: Response
      transport: "http"
    }
  | {
      kind: "stream"
      source: ResponsesStream
      transport: ResponsesTransport
    }

interface CodexResponsesHeaderOptions {
  stream?: boolean | null
}

const STRIPPED_CODEX_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "authorization",
  "cdn-loop",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "true-client-ip",
  "upgrade",
  "x-api-key",
  "x-forwarded-for",
  "x-forwarded-proto",
])

const STRIPPED_CODEX_WEBSOCKET_HEADERS = new Set(["accept", "content-type"])

const shouldForwardCodexRequestHeader = (headerName: string): boolean => {
  const headerNameLower = headerName.toLowerCase()
  return (
    !STRIPPED_CODEX_REQUEST_HEADERS.has(headerNameLower)
    && !headerNameLower.includes("trace")
    && !headerNameLower.startsWith("cf-")
  )
}

const buildForwardedCodexRequestHeaders = (
  requestHeaders: Headers,
): Headers => {
  const headers = new Headers()
  for (const [headerName, headerValue] of requestHeaders) {
    if (shouldForwardCodexRequestHeader(headerName)) {
      headers.set(headerName, headerValue)
    }
  }
  return headers
}

const setDefaultCodexHeader = (
  headers: Headers,
  headerName: string,
  headerValue: string,
): void => {
  if (!headers.has(headerName)) {
    headers.set(headerName, headerValue)
  }
}

const applyOpencodeCodexHeaders = (headers: Headers): void => {
  if (!headers.get("user-agent")?.startsWith("opencode")) {
    return
  }

  headers.set("originator", "opencode")
  const sessionId = requestContext.getStore()?.sessionAffinity
  if (sessionId) {
    headers.set("session-id", sessionId)
  }
}

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
  const headers = buildCodexRequestHeaders(requestHeaders)

  setDefaultCodexHeader(
    headers,
    "accept",
    options.stream ? "text/event-stream" : "application/json",
  )
  setDefaultCodexHeader(headers, "content-type", "application/json")
  return headers
}

export function buildCodexRequestHeaders(requestHeaders: Headers): Headers {
  const { accessToken, accountId } = requireCodexAuthContext()
  const headers = buildForwardedCodexRequestHeaders(requestHeaders)

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("chatgpt-account-id", accountId)
  setDefaultCodexHeader(headers, "originator", "copilot-api")
  setDefaultCodexHeader(headers, "user-agent", "copilot-api")
  applyOpencodeCodexHeaders(headers)
  return headers
}

export function resolveCodexResponsesTransport(
  transport?: ResponsesTransport,
): ResponsesTransport {
  const resolvedTransport =
    transport
    ?? (isConfiguredResponsesApiWebSocketEnabled() ? "websocket" : "http")
  return (
      resolvedTransport === "websocket"
        && shouldPreferResponsesHttpTransport(true)
    ) ?
      "http"
    : resolvedTransport
}

export function buildCodexResponsesWebSocketHeaders(
  requestHeaders: Headers,
): Record<string, string> {
  const headers = buildCodexResponsesHeaders(requestHeaders)
  setDefaultCodexHeader(
    headers,
    "openai-beta",
    "responses_websockets=2026-02-06",
  )
  for (const headerName of STRIPPED_CODEX_WEBSOCKET_HEADERS) {
    headers.delete(headerName)
  }
  return Object.fromEntries(headers)
}

export function buildCodexResponsesWebSocketPayload(
  payload: ResponsesPayload,
): CodexResponsesWebSocketPayload {
  const websocketPayload: CodexResponsesWebSocketPayload = {
    type: "response.create",
    ...normalizeCodexResponsesPayload(payload),
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
  options: {
    signal?: AbortSignal
    timeouts?: UpstreamLifecycleTimeouts
  } = {},
): CodexResponsesWebSocketRequest {
  const headers = buildCodexResponsesWebSocketHeaders(requestHeaders)

  return {
    headers,
    identity: buildCodexResponsesWebSocketIdentity(payload, headers, baseUrl),
    payload: buildCodexResponsesWebSocketPayload(payload),
    resourceLimits: getResponsesWebSocketResourceLimits(),
    signal: options.signal,
    timeouts: options.timeouts,
    url: buildCodexResponsesWebSocketUrl(baseUrl),
  }
}

export async function forwardCodexResponses(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
  options: {
    signal?: AbortSignal
    timeouts?: UpstreamLifecycleTimeouts
    transport?: ResponsesTransport
  } = {},
): Promise<CreateResponsesReturn> {
  const dispatched = await dispatchCodexResponses(
    payload,
    requestHeaders,
    baseUrl,
    options,
  )

  if (dispatched.kind === "stream") return dispatched.source

  const { payload: normalizedPayload, response } = dispatched

  if (!response.ok) {
    throw new HTTPError("Failed to create codex responses", response)
  }

  if (normalizedPayload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
}

export async function dispatchCodexResponses(
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string = CODEX_API_BASE_URL,
  options: {
    signal?: AbortSignal
    timeouts?: UpstreamLifecycleTimeouts
    transport?: ResponsesTransport
  } = {},
): Promise<CodexResponsesDispatch> {
  consola.log(`<-- model: ${payload.model}`)
  const transport = resolveCodexResponsesTransport(options.transport)
  if (payload.stream && transport === "websocket") {
    return {
      kind: "stream",
      source: forwardCodexResponsesOverWebSocket(
        payload,
        requestHeaders,
        baseUrl,
        options,
      ),
      transport,
    }
  }

  const normalizedPayload = normalizeCodexResponsesPayload(payload)
  const response = await fetchWithUpstreamLifecycle(
    resolveCodexResponsesUrl(baseUrl),
    {
      method: "POST",
      headers: buildCodexResponsesHeaders(requestHeaders, {
        stream: normalizedPayload.stream,
      }),
      body: JSON.stringify(normalizedPayload),
    },
    {
      signal: options.signal,
      timeouts: options.timeouts,
    },
  )

  return {
    kind: "http",
    payload: normalizedPayload,
    response,
    transport: "http",
  }
}

const normalizeCodexResponsesPayload = (
  payload: ResponsesPayload,
): ResponsesPayload => {
  const normalizedPayload: ResponsesPayload = {
    ...payload,
    store: false,
  }

  delete normalizedPayload.temperature
  delete normalizedPayload.top_p
  delete normalizedPayload.max_output_tokens
  delete normalizedPayload.metadata

  if (
    (typeof normalizedPayload.instructions === "string"
      && normalizedPayload.instructions.trim().length > 0)
    || !Array.isArray(normalizedPayload.input)
  ) {
    return normalizedPayload
  }

  const instructions: Array<string> = []
  let messageCount = 0
  const remainingInput = normalizedPayload.input.filter((inputItem) => {
    const message = getResponseInputMessage(inputItem)
    if (!message) {
      return true
    }

    messageCount += 1
    if (message.role !== "system" || messageCount > 3) {
      return true
    }

    const systemPrompt = getTextContent(message.content)
    if (systemPrompt === undefined) {
      return true
    }
    if (systemPrompt.trim().length > 0) {
      instructions.push(systemPrompt)
    }

    return false
  })

  if (remainingInput.length === normalizedPayload.input.length) {
    return normalizedPayload
  }

  if (instructions.length > 0) {
    // Codex expects system prompts in instructions instead of input messages.
    normalizedPayload.instructions = instructions.join("\n\n")
  }

  if (remainingInput.length > 0) {
    normalizedPayload.input = remainingInput
  } else {
    delete normalizedPayload.input
  }

  return normalizedPayload
}

const getResponseInputMessage = (
  inputItem: ResponseInputItem,
): ResponseInputMessage | undefined => {
  if (typeof inputItem !== "object" || inputItem === null) {
    return undefined
  }

  const { role, type } = inputItem as {
    role?: unknown
    type?: unknown
  }
  if (typeof role !== "string" || (type !== undefined && type !== "message")) {
    return undefined
  }

  return inputItem as ResponseInputMessage
}

const getTextContent = (
  content: ResponseInputMessage["content"],
): string | undefined => {
  if (typeof content === "string") {
    return content
  }

  if (content === undefined) {
    return ""
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const textBlocks: Array<string> = []
  for (const contentBlock of content) {
    const text = getTextBlock(contentBlock)
    if (text === undefined) {
      return undefined
    }

    if (text.length > 0) {
      textBlocks.push(text)
    }
  }

  return textBlocks.join("\n\n")
}

const getTextBlock = (
  contentBlock: ResponseInputContent,
): string | undefined => {
  if (typeof contentBlock !== "object" || contentBlock === null) {
    return undefined
  }

  const { text, type } = contentBlock as {
    text?: unknown
    type?: unknown
  }

  if (type !== undefined && type !== "input_text" && type !== "output_text") {
    return undefined
  }

  return typeof text === "string" ? text : undefined
}

const buildCodexResponsesWebSocketIdentity = (
  payload: ResponsesPayload,
  headers: Record<string, string>,
  baseUrl: string,
) => {
  const accountFingerprint = createHash("sha256")
    .update(state.codexAccountId ?? "missing-account")
    .digest("hex")
    .slice(0, 16)
  const authFingerprint = createHash("sha256")
    .update(
      `${state.codexAccessToken ?? "missing-token"}:${state.codexAccountId ?? "missing-account"}`,
    )
    .digest("hex")
    .slice(0, 16)
  const headerFingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(headers)
          .filter(([headerName]) => !headerName.toLowerCase().includes("trace"))
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex")
    .slice(0, 16)

  return createPooledWebSocketIdentity({
    accountFingerprint,
    origin: resolveCodexResponsesUrl(baseUrl),
    poolScope: [
      resolveCodexResponsesUrl(baseUrl),
      payload.model,
      authFingerprint,
      headerFingerprint,
    ],
    provider: "codex",
  })
}

const forwardCodexResponsesOverWebSocket = (
  payload: ResponsesPayload,
  requestHeaders: Headers,
  baseUrl: string,
  options: {
    signal?: AbortSignal
    timeouts?: UpstreamLifecycleTimeouts
  },
): ResponsesStream => {
  const websocketRequest = prepareCodexResponsesWebSocketRequest(
    payload,
    requestHeaders,
    baseUrl,
    options,
  )

  return createCodexResponsesWebSocketStream(websocketRequest)
}

const createCodexResponsesWebSocketStream = (
  request: CodexResponsesWebSocketRequest,
): ResponsesStream =>
  createCodexResponsesSafeStream(
    createPooledWebSocketStream(request, {
      createChunk: createCodexResponsesWebSocketStreamChunk,
      isReusableTerminalChunk: (chunk) => chunk.event !== "error",
      isTerminalChunk: isTerminalCodexResponsesWebSocketChunk,
      openErrorMessage: "Failed to create codex responses websocket",
      streamErrorMessage: "Codex responses websocket stream error",
      terminalChunkMissingMessage:
        "Codex responses websocket ended without a terminal response",
    }),
    request.signal,
  )

const createCodexResponsesSafeStream = async function* (
  source: AsyncIterable<ServerSentEventChunk>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEventChunk, void, unknown> {
  try {
    yield* source
  } catch (error) {
    if (!signal?.aborted && isWebSocketSentUnknownError(error)) {
      degradeResponsesWebSocketTransport("sent_unknown_disconnect")
    }
    yield createResponsesErrorServerSentEventChunk(getErrorMessage(error))
  }
}

const createCodexResponsesWebSocketStreamChunk = (
  data: string,
): ServerSentEventChunk =>
  projectResponsesWebSocketChunk(data, {
    normalizeError: normalizeCodexResponsesWebSocketError,
  })

const normalizeCodexResponsesWebSocketError = (
  event: Record<string, unknown>,
): Record<string, unknown> => {
  if (!event.error || typeof event.error !== "object") return event
  const error = event.error as Record<string, unknown>
  consola.warn("Codex responses websocket stream error:", error)
  return { ...event, message: error.message }
}

const isTerminalCodexResponsesWebSocketChunk = (
  chunk: ServerSentEventChunk,
): boolean => {
  if (!chunk.data || chunk.data === "[DONE]") {
    return false
  }

  return isResponsesStreamTerminalData(chunk.data)
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
    event: errorEvent.type,
    data: JSON.stringify(errorEvent),
  }
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return String(error)
}
