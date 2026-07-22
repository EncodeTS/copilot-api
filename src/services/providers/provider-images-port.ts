import type { Dispatcher, RequestInit as UndiciRequestInit } from "undici"

import type { ResolvedProviderConfig } from "~/lib/config"
import type { UpstreamFetch } from "~/lib/upstream-lifecycle"
import { buildCodexRequestHeaders } from "~/services/codex/create-responses"
import { buildProviderUpstreamHeaders } from "~/services/providers/provider-proxy"
import { createProviderResponsesSafeHeaders } from "~/services/providers/provider-responses-port"

export type ProviderImagesOperation = "generations" | "edits"

export const PROVIDER_IMAGES_TIMEOUT_MS = 15 * 60 * 1000

export interface ProviderImagesDispatchRequest {
  operation: ProviderImagesOperation
  request: Request
}

export interface ProviderImagesDispatch {
  adapter: "codex" | "http"
  response: Response
}

export interface ProviderImagesPort {
  dispatch(
    request: ProviderImagesDispatchRequest,
  ): Promise<ProviderImagesDispatch>
}

export interface ProviderImagesPortComposition {
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal
  fetcher?: UpstreamFetch
}

type StreamingRequestInit = RequestInit & { duplex: "half" }

type DispatcherFetch = (
  input: string | URL | Request,
  init?: UndiciRequestInit,
) => Promise<Response>

export const createProviderImagesPort = (
  providerConfig: ResolvedProviderConfig,
  composition: ProviderImagesPortComposition = {},
): ProviderImagesPort => {
  const adapter = providerConfig.name === "codex" ? "codex" : "http"
  const createTimeoutSignal =
    composition.createTimeoutSignal
    ?? ((timeoutMs: number) => AbortSignal.timeout(timeoutMs))
  const fetcher = composition.fetcher ?? fetchProviderImages

  return Object.freeze({
    dispatch: async ({ operation, request }: ProviderImagesDispatchRequest) => {
      const url =
        adapter === "codex" ?
          resolveCodexImagesUrl(providerConfig.baseUrl, request.url, operation)
        : resolveGenericImagesUrl(
            providerConfig.baseUrl,
            request.url,
            operation,
          )
      const headers =
        adapter === "codex" ?
          buildCodexRequestHeaders(request.headers)
        : buildGenericImagesHeaders(providerConfig, request.headers)
      applyImagesContentHeaders(headers, request.headers, operation)
      const signal = AbortSignal.any([
        request.signal,
        createTimeoutSignal(PROVIDER_IMAGES_TIMEOUT_MS),
      ])
      const response = await fetcher(url, {
        body: request.body,
        duplex: "half",
        headers,
        method: "POST",
        signal,
      } as StreamingRequestInit)
      return Object.freeze({
        adapter,
        response: createSafeImagesResponse(response),
      })
    },
  })
}

const fetchProviderImages: UpstreamFetch = async (input, init) => {
  if (typeof Bun !== "undefined") return await fetch(input, init)

  const { getGlobalDispatcher } = await import("undici")
  const dispatcher = createProviderImagesDispatcher(getGlobalDispatcher())
  const fetchWithDispatcher = fetch as unknown as DispatcherFetch
  return await fetchWithDispatcher(input, {
    ...init,
    dispatcher,
  } as UndiciRequestInit)
}

export const createProviderImagesDispatcher = (
  dispatcher: Dispatcher,
): Dispatcher =>
  ({
    dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ) {
      return dispatcher.dispatch(
        {
          ...options,
          bodyTimeout: PROVIDER_IMAGES_TIMEOUT_MS,
          headersTimeout: PROVIDER_IMAGES_TIMEOUT_MS,
        },
        handler,
      )
    },
  }) as Dispatcher

export const resolveCodexImagesUrl = (
  baseUrl: string,
  requestUrl: string,
  operation: ProviderImagesOperation,
): string => {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const upstreamUrl = new URL(
    normalizedBaseUrl.endsWith("/codex") ?
      `${normalizedBaseUrl}/images/${operation}`
    : `${normalizedBaseUrl}/codex/images/${operation}`,
  )
  upstreamUrl.search = new URL(requestUrl).search
  return upstreamUrl.toString()
}

const resolveGenericImagesUrl = (
  baseUrl: string,
  requestUrl: string,
  operation: ProviderImagesOperation,
): string => {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/u, "")
  const upstreamUrl = new URL(
    normalizedBaseUrl.endsWith("/v1") ?
      `${normalizedBaseUrl}/images/${operation}`
    : `${normalizedBaseUrl}/v1/images/${operation}`,
  )
  upstreamUrl.search = new URL(requestUrl).search
  return upstreamUrl.toString()
}

const buildGenericImagesHeaders = (
  providerConfig: ResolvedProviderConfig,
  requestHeaders: Headers,
): Headers => {
  const headers = new Headers(
    buildProviderUpstreamHeaders(providerConfig, requestHeaders),
  )
  const contentType = requestHeaders.get("content-type")
  if (contentType) headers.set("content-type", contentType)
  return headers
}

const applyImagesContentHeaders = (
  headers: Headers,
  requestHeaders: Headers,
  operation: ProviderImagesOperation,
): void => {
  if (!headers.has("accept")) headers.set("accept", "application/json")

  const contentType = requestHeaders.get("content-type")
  if (contentType) {
    headers.set("content-type", contentType)
  } else if (operation === "generations") {
    headers.set("content-type", "application/json")
  } else {
    headers.delete("content-type")
  }
}

const createSafeImagesResponse = (response: Response): Response =>
  new Response(response.body, {
    headers: createProviderResponsesSafeHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  })
