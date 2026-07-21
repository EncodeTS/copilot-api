import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
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

import type {
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"
import {
  forwardCodexResponses,
  resolveCodexResponsesTransport,
} from "~/services/codex/create-responses"
import {
  getCodexProviderCatalogHeaders,
  loadCodexProviderModels,
} from "~/services/codex/get-models"
import {
  createProviderProxyResponse,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"
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
    },
  ) => Promise<Response>
}

export interface ProviderResponsesComposition {
  createProviderTokenUsageRecorder?: typeof createProviderTokenUsageRecorder
  loadCodexProviderModels?: typeof loadCodexProviderModels
  resolveProviderModel?: typeof resolveProviderModel
}

interface ProviderResponsesDependencies {
  createProviderTokenUsageRecorder: typeof createProviderTokenUsageRecorder
  loadCodexProviderModels: typeof loadCodexProviderModels
  resolveProviderModel: typeof resolveProviderModel
}

const createDefaultProviderResponsesDependencies =
  (): ProviderResponsesDependencies => ({
    createProviderTokenUsageRecorder,
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

  const codexCatalog =
    providerConfig.name === "codex" ?
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
    providerConfig.name === "codex"
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
  if (
    supportsProviderResponsesContextManagement(providerConfig, payload.model)
  ) {
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

  if (providerConfig.name === "codex") {
    const transport = resolveCodexResponsesTransport()
    const upstreamResponse = await forwardCodexResponses(
      payload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: c.req.raw.signal, transport },
    )
    const recordUsage = createProviderResponsesUsageRecorder(
      payload,
      provider,
      modelConfig,
      providerConfig.pricingCurrency,
      dependencies,
    )

    if (payload.stream && isResponsesStream(upstreamResponse)) {
      return streamProviderResponses(c, upstreamResponse, {
        normalizeCodex: true,
        provider,
        recordUsage,
        transport,
      })
    }

    const responseBody = upstreamResponse as ResponsesResult
    recordUsage(normalizeResponsesUsage(responseBody.usage))
    return c.json(responseBody)
  }

  const upstreamResponse = await forwardProviderResponses(
    forwardingConfig,
    payload,
    c.req.raw.headers,
    c.req.raw.signal,
  )

  if (!upstreamResponse.ok) {
    throw new HTTPError(
      `Failed to create ${provider} responses`,
      upstreamResponse,
    )
  }

  const recordUsage = createProviderResponsesUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
    dependencies,
  )

  if (payload.stream) {
    return streamProviderResponses(c, getResponsesEvents(upstreamResponse), {
      normalizeCodex: false,
      provider,
      recordUsage,
      transport: "http",
    })
  }

  const responseBody = (await upstreamResponse
    .clone()
    .json()) as ResponsesResult
  recordUsage(normalizeResponsesUsage(responseBody.usage))

  return createProviderProxyResponse(upstreamResponse)
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
  upstreamResponse: ResponsesStream,
  options: {
    normalizeCodex: boolean
    provider: string
    recordUsage: TokenUsageRecorder
    transport: StreamTransport
  },
): Promise<Response> => {
  const prefetched = await prefetchResponsesStreamSession({
    observeFrame: (frame) => observeProviderResponsesFrame(frame, options),
    signal: c.req.raw.signal,
    source: upstreamResponse,
  })

  if (prefetched.kind === "settled") {
    recordResponsesStreamSessionUsage(options.recordUsage, prefetched.outcome)
    return projectPrefetchedProviderResponses(c, prefetched, options)
  }

  return streamSSE(c, async (stream) => {
    try {
      await relayResponsesStreamSession({
        eofErrorMessage:
          "Provider Responses stream ended without a terminal event",
        flow: "provider_responses",
        logger,
        observeFrame: (frame) => observeProviderResponsesFrame(frame, options),
        output: stream,
        projectFrame:
          options.normalizeCodex ? projectCodexResponsesFrame : undefined,
        recordUsage: options.recordUsage,
        signal: c.req.raw.signal,
        source: prefetched.source,
        transport: options.transport,
      })
    } finally {
      await prefetched.cancel()
    }
  })
}

const projectPrefetchedProviderResponses = (
  c: Context,
  prefetched: Extract<PrefetchedResponsesSession, { kind: "settled" }>,
  options: {
    normalizeCodex: boolean
    provider: string
    transport: StreamTransport
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
    return streamSSE(c, async (stream) => {
      for (const frame of prefetched.frames) {
        const message =
          options.normalizeCodex ?
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
    })
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
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

const observeProviderResponsesFrame = (
  frame: ResponsesStreamSessionFrame,
  options: { normalizeCodex: boolean; provider: string },
): void => {
  debugJsonTail(logger, "Responses stream chunk:", {
    value: frame.wire,
    tailLength: 1_000,
  })
  if (frame.kind === "malformed") {
    logger.error("provider.responses.parse_chunk_error", {
      frameKind: frame.kind,
      provider: options.provider,
    })
    return
  }
  if (!options.normalizeCodex) return
  if (frame.kind === "event") logCodexRateLimitsEvent(frame.event)
  if (frame.kind === "unknown") logCodexRateLimitsEvent(frame.parsed)
}

const projectCodexResponsesFrame = (frame: ResponsesStreamSessionFrame) => {
  const message = projectResponsesSessionFrame(frame)
  if (message && frame.kind === "event") message.event = frame.event.type
  return message
}

const asError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback)

const getResponsesEvents = (response: Response): ResponsesStream =>
  events(response)

const isResponsesStream = (value: unknown): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}
