import type { Context } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import {
  type ModelConfig,
  supportsProviderResponsesContextManagement,
} from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugJsonTail } from "~/lib/logger"
import { resolveProviderModel } from "~/lib/provider-resolver"
import { requestContext } from "~/lib/request-context"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import {
  createProviderTokenUsageRecorder,
  normalizeResponsesUsage,
  type TokenUsageRecorder,
  type UsageTokens,
} from "~/lib/token-usage"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { emitResponsesStreamError } from "~/routes/responses/stream-error"

import type {
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
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

const logger = createHandlerLogger("provider-responses-handler")

export const providerResponsesDependencies = {
  loadCodexProviderModels,
}

export async function handleProviderResponsesForProvider(
  c: Context,
  options: {
    payload: ResponsesPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  debugJson(logger, "Responses request payload:", {
    payload,
    provider,
  })
  const resolvedProviderModel = await resolveProviderModel(
    provider,
    payload.model,
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
      await providerResponsesDependencies.loadCodexProviderModels(
        c.req.raw.signal,
      )
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
): TokenUsageRecorder => {
  const sessionAffinity =
    requestContext.getStore()?.sessionAffinity?.trim() || null

  return createProviderTokenUsageRecorder({
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
  const iterator = upstreamResponse[Symbol.asyncIterator]()
  const firstResult = await iterator.next()
  if (firstResult.done) {
    throw new HTTPError(
      `Empty stream from ${options.provider} responses`,
      new Response("", { status: 502 }),
    )
  }

  const firstChunk = firstResult.value
  if (firstChunk.data && firstChunk.data !== "[DONE]") {
    const event = parseProviderResponsesStreamEvent(firstChunk.data, {
      normalizeCodex: false,
      provider: options.provider,
    })
    if (event?.type === "error") {
      const errorEvent = event
      const statusCode = errorEvent.status_code ?? 500
      return c.json(
        {
          error: {
            message: errorEvent.message,
            ...errorEvent.error,
          },
        },
        statusCode as ContentfulStatusCode,
        errorEvent.headers ?? undefined,
      )
    }
  }

  return streamSSE(c, async (stream) => {
    const streamStartedAt = Date.now()
    let usage: UsageTokens = {}
    let eventCount = 0
    let lastEventType: string | null = null
    let terminalSeen = false

    const writeChunk = async (chunk: typeof firstChunk): Promise<boolean> => {
      debugJsonTail(logger, "Responses stream chunk:", {
        value: chunk,
        tailLength: 1_000,
      })
      let responseChunk = chunk
      let event: ResponseStreamEvent | null = null

      if (chunk.data && chunk.data !== "[DONE]") {
        event = parseProviderResponsesStreamEvent(chunk.data, {
          normalizeCodex: options.normalizeCodex,
          provider: options.provider,
        })
        if (event && options.normalizeCodex) {
          responseChunk = {
            ...chunk,
            data: JSON.stringify(event),
            event: event.type,
          }
        }
      }

      if (event) {
        const nextUsage = getResponsesStreamEventUsage(event)
        if (nextUsage) {
          usage = nextUsage
        }
      }

      await stream.writeSSE({
        data: responseChunk.data ?? "",
        event: responseChunk.event,
      })
      eventCount += 1
      lastEventType = event?.type ?? responseChunk.event ?? lastEventType

      return isTerminalProviderResponsesEvent(event)
    }

    try {
      terminalSeen = await writeChunk(firstChunk)

      if (!terminalSeen) {
        for await (const chunk of {
          [Symbol.asyncIterator]: () => iterator,
        }) {
          terminalSeen = await writeChunk(chunk)
          if (terminalSeen) {
            break
          }
        }
      }

      if (!terminalSeen) {
        await emitResponsesStreamError(
          stream,
          logger,
          new Error("Provider Responses stream ended without a terminal event"),
          {
            diagnostics: {
              elapsedMs: Date.now() - streamStartedAt,
              eventCount,
              flow: "provider_responses",
              lastEventType,
              retryCount: 0,
              terminalSeen,
              transport: options.transport,
            },
            signal: c.req.raw.signal,
          },
        )
      }
    } catch (error) {
      if (!terminalSeen) {
        await emitResponsesStreamError(stream, logger, error, {
          diagnostics: {
            elapsedMs: Date.now() - streamStartedAt,
            eventCount,
            flow: "provider_responses",
            lastEventType,
            retryCount: 0,
            terminalSeen,
            transport: options.transport,
          },
          signal: c.req.raw.signal,
        })
      }
    } finally {
      options.recordUsage(usage)
    }
  })
}

const isTerminalProviderResponsesEvent = (
  event: ResponseStreamEvent | null,
): boolean =>
  event?.type === "response.completed"
  || event?.type === "response.failed"
  || event?.type === "response.incomplete"
  || event?.type === "error"

const parseProviderResponsesStreamEvent = (
  data: string,
  options: {
    normalizeCodex: boolean
    provider: string
  },
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    if (options.normalizeCodex) {
      logCodexRateLimitsEvent(parsed)
    }
    return parsed
  } catch (error) {
    logger.error("provider.responses.parse_chunk_error", {
      provider: options.provider,
      data,
      error,
    })
    return null
  }
}

const getResponsesStreamEventUsage = (
  event: ResponseStreamEvent,
): UsageTokens | null => {
  if (
    event.type === "response.completed"
    || event.type === "response.failed"
    || event.type === "response.incomplete"
  ) {
    return normalizeResponsesUsage(event.response.usage)
  }

  return null
}

const getResponsesEvents = (response: Response): ResponsesStream =>
  events(response)

const isResponsesStream = (value: unknown): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}
