import type { Context } from "hono"

import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import {
  type ModelConfig,
  supportsProviderResponsesContextManagement,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { resolveProviderModel } from "~/lib/provider-resolver"
import { requestContext } from "~/lib/request-context"
import {
  getResponsesStreamSessionFailure,
  type ResponsesStreamSessionFrame,
  type ResponsesStreamSessionOutcome,
} from "~/lib/responses-stream-session"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import {
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type TokenUsageRecorder,
} from "~/lib/token-usage"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import {
  emitResponsesStreamSessionFailure,
  projectResponsesSessionFrame,
  recordResponsesStreamSessionUsage,
  relayResponsesStreamSession,
} from "~/routes/responses/stream-session-adapter"

import type { ResponsesPayload } from "~/services/copilot/create-responses"
import {
  getCodexProviderCatalogHeaders,
  loadCodexProviderModels,
} from "~/services/codex/get-models"
import {
  createProviderResponsesPort,
  type ProviderResponsesErrorDispatch,
  type ProviderResponsesResultDispatch,
  type ProviderResponsesStreamDispatch,
} from "~/services/providers/provider-responses-port"
import { createProviderSafeResponseHeaders } from "~/services/providers/provider-proxy"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import {
  prefetchResponsesStreamSession,
  type PrefetchedResponsesSession,
} from "./stream-prefetch"

const logger = createHandlerLogger("provider-responses-handler")

export interface ProviderResponsesHandler {
  handleForProvider: (
    c: Context,
    options: {
      payload: ResponsesPayload
      provider: string
      rawBody?: Uint8Array
    },
  ) => Promise<Response>
}

export interface ProviderResponsesComposition {
  createProviderTokenUsageRecorder?: typeof createProviderTokenUsageRecorder
  createProviderResponsesPort?: typeof createProviderResponsesPort
  loadCodexProviderModels?: typeof loadCodexProviderModels
  resolveProviderModel?: typeof resolveProviderModel
}

interface ProviderResponsesDependencies {
  createProviderTokenUsageRecorder: typeof createProviderTokenUsageRecorder
  createProviderResponsesPort: typeof createProviderResponsesPort
  loadCodexProviderModels: typeof loadCodexProviderModels
  resolveProviderModel: typeof resolveProviderModel
}

const createDefaultProviderResponsesDependencies =
  (): ProviderResponsesDependencies => ({
    createProviderTokenUsageRecorder,
    createProviderResponsesPort,
    loadCodexProviderModels,
    resolveProviderModel,
  })

export const createProviderResponsesHandler = (
  composition: ProviderResponsesComposition = {},
): ProviderResponsesHandler => {
  const defaults = createDefaultProviderResponsesDependencies()
  const dependencies = Object.freeze<ProviderResponsesDependencies>({
    createProviderTokenUsageRecorder:
      composition.createProviderTokenUsageRecorder
      ?? defaults.createProviderTokenUsageRecorder,
    createProviderResponsesPort:
      composition.createProviderResponsesPort
      ?? defaults.createProviderResponsesPort,
    loadCodexProviderModels:
      composition.loadCodexProviderModels ?? defaults.loadCodexProviderModels,
    resolveProviderModel:
      composition.resolveProviderModel ?? defaults.resolveProviderModel,
  })
  const handler: ProviderResponsesHandler = {
    handleForProvider: (c, options) =>
      handleProviderResponsesForProviderWithDependencies(
        c,
        options,
        dependencies,
      ),
  }
  return Object.freeze(handler)
}

export async function handleProviderResponsesForProvider(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
    rawBody?: Uint8Array
  },
): Promise<Response> {
  return await handleProviderResponsesForProviderWithDependencies(
    c,
    options,
    createDefaultProviderResponsesDependencies(),
  )
}

async function handleProviderResponsesForProviderWithDependencies(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
    rawBody?: Uint8Array
  },
  dependencies: ProviderResponsesDependencies,
): Promise<Response> {
  const { payload, provider } = options
  debugJson(logger, "Responses request payload:", {
    payload,
    provider,
  })
  const resolvedProviderModel = await dependencies.resolveProviderModel(
    provider,
    payload.model,
    { signal: c.req.raw.signal },
  )
  if (
    !resolvedProviderModel
    || resolvedProviderModel.type !== "openai-responses"
  ) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' does not support the /v1/responses endpoint`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }
  const {
    config: providerConfig,
    forwardingConfig,
    modelConfig,
  } = resolvedProviderModel
  const responsesPort =
    dependencies.createProviderResponsesPort(forwardingConfig)

  const codexCatalog =
    responsesPort.adapter === "codex" ?
      await dependencies.loadCodexProviderModels(c.req.raw.signal)
    : undefined
  if (codexCatalog) {
    for (const [name, value] of Object.entries(
      getCodexProviderCatalogHeaders(codexCatalog),
    )) {
      c.header(name, value)
    }
  }
  const model = codexCatalog?.catalog.data.find(
    (model) => model.id === payload.model,
  )
  const requestedEffort = payload.reasoning?.effort
  if (
    responsesPort.adapter === "codex"
    && requestedEffort
    && !model?.capabilities.supports.reasoning_effort?.includes(requestedEffort)
  ) {
    return c.json(
      {
        error: {
          message: `Reasoning effort '${requestedEffort}' is not supported by Codex model '${payload.model}'`,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate.
  let rawBody = options.rawBody
  if (
    supportsProviderResponsesContextManagement(providerConfig, payload.model)
  ) {
    rawBody = undefined
    const contextManagementDecision = applyResponsesApiContextManagement(
      payload,
      model?.capabilities.limits,
      {
        compactThresholdRatio: 0.8,
        source: "responses",
      },
    )
    if (contextManagementDecision.shouldPruneInput) {
      compactInputByLatestCompaction(payload)
    }
  }

  debugJson(logger, "Translated Responses request payload:", {
    contextManagement: payload.context_management,
    provider,
  })

  const recordUsage = createProviderResponsesUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
    dependencies,
  )
  const dispatched = await responsesPort.dispatch({
    payload,
    rawBody,
    requestHeaders: c.req.raw.headers,
    requestUrl: c.req.raw.url,
    signal: c.req.raw.signal,
  })

  if (dispatched.kind === "error") {
    const rawBody = new Uint8Array(await dispatched.response.arrayBuffer())
    await dispatched.cancel(
      new Error(`Provider Responses error ${dispatched.status} consumed`),
    )
    return createExactProviderResponsesResponse(c, rawBody, dispatched)
  }

  if (dispatched.kind === "stream") {
    return streamProviderResponses(c, dispatched, {
      provider,
      recordUsage,
    })
  }

  recordUsage(normalizeResponsesUsage(dispatched.result.usage))
  await dispatched.cancel(new Error("Provider Responses result consumed"))
  return createExactProviderResponsesResponse(c, dispatched.rawBody, dispatched)
}

const createProviderResponsesUsageRecorder = (
  payload: ResponsesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
  dependencies: ProviderResponsesDependencies,
): TokenUsageRecorder => {
  const sessionAffinity =
    requestContext.getStore()?.sessionAffinity?.trim() || null

  return dependencies.createProviderTokenUsageRecorder({
    endpoint: "responses",
    model: payload.model,
    outcome: "completed",
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
    sessionId: sessionAffinity ?? "",
  })
}

const streamProviderResponses = async (
  c: Context,
  dispatched: ProviderResponsesStreamDispatch,
  options: {
    provider: string
    recordUsage: TokenUsageRecorder
  },
): Promise<Response> => {
  applyProviderResponsesStreamMetadata(c, dispatched)
  const prefetched = await prefetchResponsesStreamSession({
    observeFrame: (frame) =>
      observeProviderResponsesFrame(frame, dispatched, options.provider),
    signal: dispatched.signal,
    source: dispatched.source,
  })

  if (prefetched.kind === "settled") {
    try {
      recordResponsesStreamSessionUsage(options.recordUsage, prefetched.outcome)
      return projectPrefetchedProviderResponses(c, prefetched, {
        normalizeSseEventNames: dispatched.normalizeSseEventNames,
        provider: options.provider,
        status: dispatched.status,
        statusText: dispatched.statusText,
        transport: dispatched.transport,
      })
    } finally {
      await dispatched.cancel(
        new Error("Provider Responses prefetched stream settled"),
      )
    }
  }

  return createExactProviderResponsesStreamResponse(
    streamSSE(c, async (stream) => {
      try {
        await relayResponsesStreamSession({
          eofErrorMessage:
            "Provider Responses stream ended without a terminal event",
          flow: "provider_responses",
          logger,
          observeFrame: (frame) =>
            observeProviderResponsesFrame(frame, dispatched, options.provider),
          output: stream,
          projectFrame:
            dispatched.normalizeSseEventNames ?
              projectCodexResponsesFrame
            : undefined,
          recordUsage: options.recordUsage,
          signal: dispatched.signal,
          source: prefetched.source,
          transport: dispatched.transport,
        })
      } finally {
        await prefetched.cancel()
        await dispatched.cancel(new Error("Provider Responses stream finished"))
      }
    }),
    dispatched,
  )
}

const projectPrefetchedProviderResponses = (
  c: Context,
  prefetched: Extract<PrefetchedResponsesSession, { kind: "settled" }>,
  options: {
    normalizeSseEventNames: boolean
    provider: string
    status: number
    statusText: string
    transport: ProviderResponsesStreamDispatch["transport"]
  },
): Response => {
  const { outcome } = prefetched
  if (outcome.kind === "error") {
    const errorEvent = outcome.terminal.event
    const statusCode =
      typeof errorEvent.status_code === "number" ? errorEvent.status_code : 500
    return c.json(
      {
        error: {
          message: errorEvent.message,
          ...errorEvent.error,
        },
      },
      statusCode as ContentfulStatusCode,
      toHeaderRecord(errorEvent.headers),
    )
  }

  if (
    outcome.kind === "completed"
    || outcome.kind === "failed"
    || outcome.kind === "incomplete"
    || (outcome.kind === "eof" && outcome.endedBy === "done")
  ) {
    return createExactProviderResponsesStreamResponse(
      streamSSE(c, async (stream) => {
        for (const frame of prefetched.frames) {
          const message =
            options.normalizeSseEventNames ?
              projectCodexResponsesFrame(frame)
            : projectResponsesSessionFrame(frame)
          if (message) await stream.writeSSE(message)
        }
        if (outcome.kind === "eof") {
          await emitPrefetchedProviderStreamFailure(
            stream,
            outcome,
            options.transport,
            c.req.raw.signal,
          )
        }
      }),
      options,
    )
  }

  if (outcome.kind === "abort") {
    throw asError(outcome.reason, "Provider Responses request aborted")
  }
  if (outcome.kind === "throw") throw outcome.error
  if (outcome.kind === "timeout") throw outcome.error
  if (outcome.kind === "delivery_failed") throw outcome.deliveryError
  throw new HTTPError(
    `Empty stream from ${options.provider} responses`,
    new Response("", { status: 502 }),
  )
}

const emitPrefetchedProviderStreamFailure = async (
  stream: SSEStreamingApi,
  outcome: ResponsesStreamSessionOutcome,
  transport: StreamTransport,
  signal: AbortSignal,
): Promise<void> => {
  const failure = getResponsesStreamSessionFailure(
    outcome,
    "Provider Responses stream ended without a terminal event",
  )
  if (!failure) return
  await emitResponsesStreamSessionFailure({
    error: failure.error,
    flow: "provider_responses",
    logger,
    outcome,
    output: stream,
    signal,
    transport,
  })
}

const toHeaderRecord = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  if (entries.length === 0) return undefined
  const headers = createProviderSafeResponseHeaders(new Headers(entries))
  return Object.keys(headers).length > 0 ? { ...headers } : undefined
}

const observeProviderResponsesFrame = (
  frame: ResponsesStreamSessionFrame,
  dispatched: ProviderResponsesStreamDispatch,
  provider: string,
): void => {
  debugJsonTail(logger, "Responses stream chunk:", {
    value: frame.wire,
    tailLength: 1_000,
  })
  if (frame.kind === "malformed") {
    logger.error("provider.responses.parse_chunk_error", {
      frameKind: frame.kind,
      provider,
    })
    return
  }
  if (frame.kind === "event") dispatched.observer(frame.event)
  if (frame.kind === "unknown") dispatched.observer(frame.parsed)
}

const projectCodexResponsesFrame = (frame: ResponsesStreamSessionFrame) => {
  const message = projectResponsesSessionFrame(frame)
  if (message && frame.kind === "event") message.event = frame.event.type
  return message
}

const asError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback)

const applyProviderResponsesHeaders = (
  c: Context,
  headers: Readonly<Record<string, string>>,
): void => {
  for (const [name, value] of Object.entries(headers)) {
    c.header(name, value)
  }
}

const applyProviderResponsesStreamMetadata = (
  c: Context,
  dispatched: ProviderResponsesStreamDispatch,
): void => {
  c.status(dispatched.status as ContentfulStatusCode)
  for (const [name, value] of Object.entries(dispatched.headers)) {
    if (name.toLowerCase() !== "content-type") c.header(name, value)
  }
}

const createExactProviderResponsesStreamResponse = (
  response: Response,
  dispatched: Pick<ProviderResponsesStreamDispatch, "status" | "statusText">,
): Response =>
  new Response(response.body, {
    headers: response.headers,
    status: dispatched.status,
    statusText: dispatched.statusText,
  })

const createExactProviderResponsesResponse = (
  c: Context,
  rawBody: Uint8Array<ArrayBuffer>,
  dispatched: Pick<
    ProviderResponsesErrorDispatch | ProviderResponsesResultDispatch,
    "headers" | "status" | "statusText"
  >,
): Response => {
  applyProviderResponsesHeaders(c, dispatched.headers)
  return new Response(rawBody, {
    headers: new Headers(c.res.headers),
    status: dispatched.status,
    statusText: dispatched.statusText,
  })
}
