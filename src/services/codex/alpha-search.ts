import {
  fetchWithUpstreamLifecycle,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import {
  buildCodexRequestHeaders,
  CODEX_API_BASE_URL,
} from "~/services/codex/create-responses"

const CODEX_ALPHA_SEARCH_URL = `${CODEX_API_BASE_URL}/codex/alpha/search`

export function resolveCodexAlphaSearchUrl(
  requestUrl: string,
  baseUrl: string = CODEX_API_BASE_URL,
): string {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const endpoint =
    !normalizedBaseUrl ? CODEX_ALPHA_SEARCH_URL
    : normalizedBaseUrl.endsWith("/codex/alpha/search") ? normalizedBaseUrl
    : normalizedBaseUrl.endsWith("/codex") ? `${normalizedBaseUrl}/alpha/search`
    : `${normalizedBaseUrl}/codex/alpha/search`
  return `${endpoint}${getExactAlphaSearchQuery(requestUrl)}`
}

export interface CodexAlphaSearchDispatchRequest {
  baseUrl?: string
  body: Uint8Array
  requestHeaders: Headers
  requestUrl: string
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
}

export const dispatchCodexAlphaSearch = async (
  request: CodexAlphaSearchDispatchRequest,
): Promise<Response> => {
  const headers = buildCodexRequestHeaders(request.requestHeaders)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return await fetchWithUpstreamLifecycle(
    resolveCodexAlphaSearchUrl(request.requestUrl, request.baseUrl),
    {
      body: getAlphaSearchFetchBody(request.body),
      headers,
      method: "POST",
    },
    { signal: request.signal, timeouts: request.timeouts },
  )
}

export const forwardCodexAlphaSearch = async (
  request: Request,
  options: {
    baseUrl?: string
    signal?: AbortSignal
    timeouts?: UpstreamLifecycleTimeouts
  } = {},
): Promise<Response> =>
  await dispatchCodexAlphaSearch({
    baseUrl: options.baseUrl,
    body: new Uint8Array(await request.arrayBuffer()),
    requestHeaders: request.headers,
    requestUrl: request.url,
    signal:
      options.signal ?
        AbortSignal.any([request.signal, options.signal])
      : request.signal,
    timeouts: options.timeouts,
  })

export const getExactAlphaSearchQuery = (requestUrl: string): string => {
  const queryStart = requestUrl.indexOf("?")
  if (queryStart < 0) return ""

  const fragmentStart = requestUrl.indexOf("#", queryStart)
  return fragmentStart < 0 ?
      requestUrl.slice(queryStart)
    : requestUrl.slice(queryStart, fragmentStart)
}

export const getAlphaSearchFetchBody = (
  body: Uint8Array,
): Uint8Array<ArrayBuffer> =>
  body.buffer instanceof ArrayBuffer ?
    (body as Uint8Array<ArrayBuffer>)
  : new Uint8Array(body)
