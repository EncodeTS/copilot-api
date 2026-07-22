import { events } from "fetch-event-stream"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import type { ResolvedProviderConfig } from "~/lib/config"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import type { UpstreamLifecycleTimeouts } from "~/lib/upstream-lifecycle"
import {
  dispatchCodexResponses,
  type CodexResponsesDispatch,
} from "~/services/codex/create-responses"
import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
  ResponsesTransport,
} from "~/services/copilot/create-responses"

import {
  createProviderSafeResponseHeaders,
  forwardProviderResponses,
} from "./provider-proxy"

export type ProviderResponsesAdapter = "codex" | "http"

export type ProviderResponsesObserver = (event: unknown) => void

interface ProviderResponsesDispatchBase {
  readonly adapter: ProviderResponsesAdapter
  readonly cancel: (reason?: unknown) => Promise<void>
  readonly headers: Readonly<Record<string, string>>
  readonly normalizeSseEventNames: boolean
  readonly observer: ProviderResponsesObserver
  readonly signal: AbortSignal
  readonly status: number
  readonly statusText: string
  readonly transport: StreamTransport
}

export interface ProviderResponsesResultDispatch
  extends ProviderResponsesDispatchBase {
  readonly kind: "result"
  readonly rawBody: Uint8Array<ArrayBuffer>
  readonly result: ResponsesResult
}

export interface ProviderResponsesStreamDispatch
  extends ProviderResponsesDispatchBase {
  readonly kind: "stream"
  readonly source: ResponsesStream
}

export interface ProviderResponsesErrorDispatch
  extends ProviderResponsesDispatchBase {
  readonly kind: "error"
  readonly response: Response
}

export type ProviderResponsesDispatch =
  | ProviderResponsesErrorDispatch
  | ProviderResponsesResultDispatch
  | ProviderResponsesStreamDispatch

export interface ProviderResponsesDispatchRequest {
  payload: ResponsesPayload
  rawBody?: Uint8Array
  requestHeaders: Headers
  requestUrl?: string
  signal?: AbortSignal
  timeouts?: UpstreamLifecycleTimeouts
  transport?: ResponsesTransport
}

export interface ProviderResponsesPort {
  readonly adapter: ProviderResponsesAdapter
  readonly prefersStreamingForBufferedResults: boolean
  readonly dispatch: (
    request: ProviderResponsesDispatchRequest,
  ) => Promise<ProviderResponsesDispatch>
}

export interface ProviderResponsesPortComposition {
  dispatchCodexResponses?: typeof dispatchCodexResponses
  forwardProviderResponses?: typeof forwardProviderResponses
  observeCodexRateLimitsEvent?: typeof logCodexRateLimitsEvent
}

export const createProviderResponsesPort = (
  providerConfig: ResolvedProviderConfig,
  composition: ProviderResponsesPortComposition = {},
): ProviderResponsesPort => {
  const adapter: ProviderResponsesAdapter =
    providerConfig.name === "codex" ? "codex" : "http"
  const observer =
    adapter === "codex" ?
      (composition.observeCodexRateLimitsEvent ?? logCodexRateLimitsEvent)
    : () => {}
  const dependencies = Object.freeze({
    dispatchCodexResponses:
      composition.dispatchCodexResponses ?? dispatchCodexResponses,
    forwardProviderResponses:
      composition.forwardProviderResponses ?? forwardProviderResponses,
  })

  return Object.freeze({
    adapter,
    dispatch: async (request: ProviderResponsesDispatchRequest) => {
      const control = createDispatchControl(request.signal)
      try {
        if (adapter === "codex") {
          const dispatched = await dependencies.dispatchCodexResponses(
            request.payload,
            request.requestHeaders,
            providerConfig.baseUrl,
            {
              signal: control.signal,
              timeouts: request.timeouts,
              transport: request.transport,
            },
          )
          return await adaptCodexDispatch(dispatched, {
            control,
            observer,
          })
        }

        const response = await dependencies.forwardProviderResponses(
          providerConfig,
          {
            payload: request.payload,
            rawBody: request.rawBody,
            requestHeaders: request.requestHeaders,
            requestUrl: request.requestUrl,
            signal: control.signal,
            timeouts: request.timeouts,
          },
        )
        return await adaptHttpResponse(response, request.payload, {
          adapter,
          control,
          normalizeSseEventNames: false,
          observer,
        })
      } catch (error) {
        await control.cancel(error)
        throw error
      }
    },
    prefersStreamingForBufferedResults: adapter === "codex",
  })
}

const adaptCodexDispatch = async (
  dispatched: CodexResponsesDispatch,
  options: {
    control: ProviderResponsesDispatchControl
    observer: ProviderResponsesObserver
  },
): Promise<ProviderResponsesDispatch> => {
  if (dispatched.kind === "stream") {
    return createManagedStreamDispatch(dispatched.source, {
      adapter: "codex",
      control: options.control,
      headers: Object.freeze({}),
      normalizeSseEventNames: true,
      observer: options.observer,
      signal: options.control.signal,
      status: 200,
      statusText: "",
      transport: dispatched.transport,
    })
  }

  return await adaptHttpResponse(dispatched.response, dispatched.payload, {
    adapter: "codex",
    control: options.control,
    normalizeSseEventNames: true,
    observer: options.observer,
  })
}

const adaptHttpResponse = async (
  response: Response,
  payload: ResponsesPayload,
  options: {
    adapter: ProviderResponsesAdapter
    control: ProviderResponsesDispatchControl
    normalizeSseEventNames: boolean
    observer: ProviderResponsesObserver
  },
): Promise<ProviderResponsesDispatch> => {
  const headers = createProviderSafeResponseHeaders(response.headers)
  const common = {
    adapter: options.adapter,
    headers,
    normalizeSseEventNames: options.normalizeSseEventNames,
    observer: options.observer,
    signal: options.control.signal,
    status: response.status,
    statusText: response.statusText,
    transport: "http" as const,
  }

  if (!response.ok) {
    return Object.freeze({
      ...common,
      cancel: options.control.cancel,
      kind: "error" as const,
      response: new Response(response.body, {
        headers,
        status: response.status,
        statusText: response.statusText,
      }),
    })
  }

  if (payload.stream && isStreamingHttpResponse(response)) {
    return createManagedStreamDispatch(
      events(response, options.control.signal),
      { ...common, control: options.control },
      response.body,
    )
  }

  const rawBody = new Uint8Array(await response.arrayBuffer())
  return Object.freeze({
    ...common,
    cancel: options.control.cancel,
    kind: "result" as const,
    rawBody,
    result: (await new Response(rawBody).json()) as ResponsesResult,
  })
}

const createManagedStreamDispatch = (
  source: ResponsesStream,
  base: Omit<ProviderResponsesStreamDispatch, "cancel" | "kind" | "source"> & {
    control: ProviderResponsesDispatchControl
  },
  responseBody?: ReadableStream<Uint8Array> | null,
): ProviderResponsesStreamDispatch => {
  const { cancel: cancelSource, source: managedSource } =
    createManagedResponsesSource(source, responseBody)
  const { control, ...dispatchBase } = base
  let cancellation: Promise<void> | undefined
  return Object.freeze({
    ...dispatchBase,
    cancel: (reason?: unknown) => {
      cancellation ??= (async () => {
        await control.cancel(reason)
        await cancelSource(reason)
      })()
      return cancellation
    },
    kind: "stream",
    source: managedSource,
  })
}

interface ProviderResponsesDispatchControl {
  cancel: (reason?: unknown) => Promise<void>
  signal: AbortSignal
}

const createDispatchControl = (
  callerSignal: AbortSignal | undefined,
): ProviderResponsesDispatchControl => {
  const controller = new AbortController()
  const signal =
    callerSignal ?
      AbortSignal.any([callerSignal, controller.signal])
    : controller.signal
  return Object.freeze({
    cancel: (reason?: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(reason)
      }
      return Promise.resolve()
    },
    signal,
  })
}

const isStreamingHttpResponse = (response: Response): boolean => {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  return (
    contentType.includes("text/event-stream") || !contentType.includes("json")
  )
}

const createManagedResponsesSource = (
  source: ResponsesStream,
  responseBody?: ReadableStream<Uint8Array> | null,
): {
  cancel: (reason?: unknown) => Promise<void>
  source: ResponsesStream
} => {
  const openIterators = new Set<ManagedResponsesIterator>()
  let cancellation: Promise<void> | undefined
  let cancellationReason: unknown

  const managedSource: ResponsesStream = {
    [Symbol.asyncIterator]() {
      const inner = source[Symbol.asyncIterator]()
      const managed = createManagedResponsesIterator(inner, () => {
        openIterators.delete(managed)
      })
      openIterators.add(managed)
      if (cancellation) void managed.return?.()
      return managed
    },
  }

  return {
    cancel: (reason?: unknown) => {
      if (!cancellation) {
        cancellationReason = reason
        cancellation = (async () => {
          await Promise.all(
            [...openIterators].map(async (iterator) => {
              await iterator.return?.()
            }),
          )
          if (responseBody && !responseBody.locked) {
            await responseBody.cancel(cancellationReason).catch(() => {})
          }
        })()
      }
      return cancellation
    },
    source: managedSource,
  }
}

type ResponsesStreamChunk =
  ResponsesStream extends AsyncIterable<infer Chunk> ? Chunk : never

type ManagedResponsesIterator = AsyncIterator<ResponsesStreamChunk>

const createManagedResponsesIterator = (
  inner: AsyncIterator<ResponsesStreamChunk>,
  onClose: () => void,
): ManagedResponsesIterator => {
  let closing: Promise<IteratorResult<never>> | undefined
  const close = (value?: unknown): Promise<IteratorResult<never>> => {
    closing ??= Promise.resolve(inner.return?.(value))
      .then(
        (result) =>
          (result ?? { done: true, value: undefined }) as IteratorResult<never>,
      )
      .finally(onClose)
    return closing
  }
  return {
    next: () => inner.next(),
    return: close,
    throw: async (error?: unknown) => {
      try {
        if (inner.throw) return await inner.throw(error)
        throw error
      } finally {
        onClose()
      }
    },
  }
}
