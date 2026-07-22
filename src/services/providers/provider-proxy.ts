import consola from "consola"
import type { ResolvedProviderConfig } from "~/lib/config"
import {
  fetchWithUpstreamLifecycle,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesPayload } from "~/services/copilot/create-responses"

const SHARED_FORWARDABLE_HEADERS = ["accept", "user-agent"] as const

const ANTHROPIC_FORWARDABLE_HEADERS = [
  "anthropic-version",
  "anthropic-beta",
] as const

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

export function buildProviderUpstreamHeaders(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Record<string, string> {
  const authHeaders: Record<string, string> = {}
  if (providerConfig.authType === "x-api-key") {
    authHeaders["x-api-key"] = providerConfig.apiKey
  } else {
    authHeaders.authorization = `Bearer ${providerConfig.apiKey}`
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...authHeaders,
  }

  for (const headerName of SHARED_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  if (providerConfig.type !== "anthropic") {
    return headers
  }

  for (const headerName of ANTHROPIC_FORWARDABLE_HEADERS) {
    const headerValue = requestHeaders.get(headerName)
    if (headerValue) {
      headers[headerName] = headerValue
    }
  }

  return headers
}

export function createProviderProxyResponse(
  upstreamResponse: Response,
  body?: ReadableStream<Uint8Array> | null,
): Response {
  const headers = createProviderSafeResponseHeaders(upstreamResponse.headers)

  return new Response(body ?? upstreamResponse.body, {
    headers,
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
  })
}

export function createProviderSafeResponseHeaders(
  headers: Headers,
): Readonly<Record<string, string>> {
  const safeHeaders = Object.create(null) as Record<string, string>
  for (const [name, value] of headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      safeHeaders[name] = value
    }
  }
  return Object.freeze(safeHeaders)
}

export async function forwardProviderMessages(
  providerConfig: ResolvedProviderConfig,
  payload: AnthropicMessagesPayload,
  requestHeaders: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  return await fetchWithUpstreamLifecycle(
    `${providerConfig.baseUrl}/v1/messages`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
      body: JSON.stringify(payload),
    },
    { signal },
  )
}

export async function forwardProviderChatCompletions(
  providerConfig: ResolvedProviderConfig,
  payload: ChatCompletionsPayload,
  requestHeaders: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  return await fetchWithUpstreamLifecycle(
    `${providerConfig.baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
      body: JSON.stringify(payload),
    },
    { signal },
  )
}

export async function forwardProviderResponses(
  providerConfig: ResolvedProviderConfig,
  payload: ResponsesPayload,
  requestHeaders: Headers,
  signal?: AbortSignal,
  timeouts?: UpstreamLifecycleTimeouts,
): Promise<Response> {
  consola.log(`<-- model: ${payload.model}`)
  return await fetchWithUpstreamLifecycle(
    `${providerConfig.baseUrl}/v1/responses`,
    {
      method: "POST",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
      body: JSON.stringify(payload),
    },
    { signal, timeouts },
  )
}

export async function forwardProviderModels(
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
  signal?: AbortSignal,
): Promise<Response> {
  return await fetchWithUpstreamLifecycle(
    `${providerConfig.baseUrl}/v1/models`,
    {
      method: "GET",
      headers: buildProviderUpstreamHeaders(providerConfig, requestHeaders),
    },
    { signal },
  )
}
