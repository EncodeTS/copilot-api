import type { ResolvedProviderConfig } from "~/lib/config"
import {
  fetchWithUpstreamLifecycle,
  type UpstreamLifecycleTimeouts,
} from "~/lib/upstream-lifecycle"
import {
  dispatchCodexAlphaSearch,
  getAlphaSearchFetchBody,
  getExactAlphaSearchQuery,
  resolveCodexAlphaSearchUrl,
} from "~/services/codex/alpha-search"

import { buildProviderUpstreamHeaders } from "./provider-proxy"
import { createProviderResponsesSafeHeaders } from "./provider-responses-port"

export type ProviderAlphaSearchAdapter = "codex" | "http"

export interface ProviderAlphaSearchDispatch {
  readonly adapter: ProviderAlphaSearchAdapter
  readonly headers: Readonly<Record<string, string>>
  readonly response: Response
  readonly status: number
  readonly statusText: string
}

export interface ProviderAlphaSearchDispatchRequest {
  body: Uint8Array
  requestHeaders: Headers
  requestUrl: string
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
}

export interface ProviderAlphaSearchPort {
  readonly adapter: ProviderAlphaSearchAdapter
  readonly dispatch: (
    request: ProviderAlphaSearchDispatchRequest,
  ) => Promise<ProviderAlphaSearchDispatch>
}

export const createProviderAlphaSearchPort = (
  providerConfig: ResolvedProviderConfig,
): ProviderAlphaSearchPort => {
  const adapter: ProviderAlphaSearchAdapter =
    providerConfig.name === "codex" ? "codex" : "http"

  return Object.freeze({
    adapter,
    dispatch: async (request: ProviderAlphaSearchDispatchRequest) => {
      const response =
        adapter === "codex" ?
          await dispatchCodexAlphaSearch({
            baseUrl: providerConfig.baseUrl,
            body: request.body,
            requestHeaders: request.requestHeaders,
            requestUrl: request.requestUrl,
            signal: request.signal,
            timeouts: request.timeouts,
          })
        : await fetchWithUpstreamLifecycle(
            resolveProviderAlphaSearchUrl(
              providerConfig,
              request.requestUrl,
              adapter,
            ),
            {
              body: getAlphaSearchFetchBody(request.body),
              headers: createGenericAlphaSearchHeaders(
                providerConfig,
                request.requestHeaders,
              ),
              method: "POST",
            },
            {
              signal: request.signal,
              timeouts: request.timeouts,
            },
          )
      const safeHeaders = createProviderResponsesSafeHeaders(response.headers)
      return Object.freeze({
        adapter,
        headers: safeHeaders,
        response: new Response(response.body, {
          headers: safeHeaders,
          status: response.status,
          statusText: response.statusText,
        }),
        status: response.status,
        statusText: response.statusText,
      })
    },
  })
}

export const resolveProviderAlphaSearchUrl = (
  providerConfig: ResolvedProviderConfig,
  requestUrl: string,
  adapter: ProviderAlphaSearchAdapter = providerConfig.name === "codex" ?
    "codex"
  : "http",
): string => {
  if (adapter === "codex") {
    return resolveCodexAlphaSearchUrl(requestUrl, providerConfig.baseUrl)
  }

  const normalizedBaseUrl = providerConfig.baseUrl.trim().replace(/\/+$/u, "")
  const endpoint =
    normalizedBaseUrl.endsWith("/v1/alpha/search") ? normalizedBaseUrl
    : normalizedBaseUrl.endsWith("/v1") ? `${normalizedBaseUrl}/alpha/search`
    : `${normalizedBaseUrl}/v1/alpha/search`
  return `${endpoint}${getExactAlphaSearchQuery(requestUrl)}`
}

const createGenericAlphaSearchHeaders = (
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Headers => {
  const headers = new Headers(
    buildProviderUpstreamHeaders(providerConfig, requestHeaders),
  )

  if (!headers.has("accept")) headers.set("accept", "application/json")
  headers.set(
    "content-type",
    requestHeaders.get("content-type") ?? "application/json",
  )
  return headers
}
