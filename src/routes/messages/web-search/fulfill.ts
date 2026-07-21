import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"

import {
  getMessageApiWebSearchModel,
  isResponsesApiWebSearchEnabled,
} from "~/lib/config"
import { debugJson } from "~/lib/logger"
import { findEndpointModel } from "~/lib/models"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import {
  createCopilotTokenUsageRecorder,
  type TokenUsageRecorder,
} from "~/lib/token-usage"
import {
  generateRequestIdFromPayload,
  getRootSessionId,
  getUUID,
  parseUserIdMetadata,
} from "~/lib/utils"
import {
  createResponses as createCopilotResponses,
  type ResponsesResult,
  type ResponsesStream,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import type { AnthropicMessagesPayload } from "../anthropic-types"
import { normalizeSystemMessages } from "../preprocess"
import {
  BufferedResponsesTerminalError,
  collectResponsesStreamResult,
  recordBufferedResponsesTerminalFailure,
} from "../responses-stream-collection"
import { createBufferedResponsesProtocolError } from "../responses-result"
import {
  getResponsesRequestOptions,
  getResponsesTransportForModel,
} from "../../responses/utils"
import { createOptimizedCopilotResponses } from "../../responses/optimized-create"
import {
  applyWebSearchFallbackHeaders,
  applyWebSearchReasoningEffort,
  createWebSearchInvalidRequestError,
  createWebSearchUnsupportedResponse,
  hasWebSearchServerTool,
  prepareWebSearchResponsesPayload,
  resolveWebSearchRoute,
} from "./policy"
import {
  buildSyntheticStreamEvents,
  getWebSearchUsageMetadata,
  normalizeWebSearchResponsesUsage,
  reconstructWebSearchResponse,
} from "./reconstruction"

export * from "./policy"
export * from "./reconstruction"

export const webSearchFlowDependencies = {
  createResponses: createCopilotResponses,
  findEndpointModel,
  createUsageRecorder: (
    payload: AnthropicMessagesPayload,
    sessionId?: string,
    webSearchModel?: string,
  ): TokenUsageRecorder =>
    createCopilotTokenUsageRecorder({
      endpoint: "responses",
      fallbackSessionId: sessionId,
      model: webSearchModel ?? payload.model,
      outcome: "completed",
      sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
    }),
}

export interface WebSearchFlowOptions {
  logger: ConsolaInstance
  reasoningRecoverySessionId?: string
  subagentMarker?: SubagentMarker | null
  /** GPT (Responses-capable) model the web search request is switched to. */
  webSearchModel: string
  requestId: string
  sessionId?: string
  signal?: AbortSignal
  compactType?: CompactType
}

const isWebSearchResponsesStream = (value: unknown): value is ResponsesStream =>
  Boolean(value)
  && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"

const createUsageRecorder = (
  payload: AnthropicMessagesPayload,
  sessionId?: string,
  webSearchModel?: string,
): TokenUsageRecorder =>
  webSearchFlowDependencies.createUsageRecorder(
    payload,
    sessionId,
    webSearchModel,
  )

/** Resolve the configured fallback after explicit provider aliases are handled. */
export const tryHandleWebSearch = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: {
    logger: ConsolaInstance
    forwardToProvider: (
      c: Context,
      payload: AnthropicMessagesPayload,
      provider: string,
    ) => Promise<Response>
  },
): Promise<Response | null> => {
  if (!hasWebSearchServerTool(payload)) return null

  normalizeSystemMessages(payload)

  const route = resolveWebSearchRoute(payload, {
    webSearchModel: getMessageApiWebSearchModel(),
    responsesWebSearchEnabled: isResponsesApiWebSearchEnabled(),
  })

  if (route.kind === "provider") {
    payload.model = route.alias.model
    return await options.forwardToProvider(c, payload, route.alias.provider)
  }

  if (route.kind === "responses") {
    const reasoningRecoverySessionId = getRootSessionId(payload, c)
    let sessionId = reasoningRecoverySessionId
    const requestId = generateRequestIdFromPayload(
      payload,
      reasoningRecoverySessionId,
    )
    if (!sessionId) {
      sessionId = getUUID(requestId)
    }
    return await handleWebSearchViaResponses(c, payload, {
      subagentMarker: null,
      webSearchModel: route.model,
      reasoningRecoverySessionId,
      requestId,
      sessionId,
      signal: c.req.raw.signal,
      compactType: 0,
      logger: options.logger,
    })
  }

  return createWebSearchUnsupportedResponse(c, route.message)
}

/** Execute the bounded Responses fallback and adapt its result to Messages. */
export const handleWebSearchViaResponses = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: WebSearchFlowOptions,
) => {
  const { logger, webSearchModel } = options
  const wantsStream = Boolean(payload.stream)
  applyWebSearchFallbackHeaders(c, payload, logger)

  const responsesPayload = prepareWebSearchResponsesPayload(payload, {
    model: webSearchModel,
    subagentAgentId: options.subagentMarker?.agent_id,
  })

  const selectedModel: Model | undefined =
    webSearchFlowDependencies.findEndpointModel(webSearchModel)
  const reasoningError = applyWebSearchReasoningEffort(
    payload,
    responsesPayload,
    selectedModel,
  )
  if (reasoningError) {
    throw createWebSearchInvalidRequestError(reasoningError)
  }
  const endpointCapabilities = getResponsesEndpointCapabilities(selectedModel)
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, {
      compactType: options.compactType,
    }) ?? "http"

  debugJson(
    logger,
    `Switching web search request to model: ${webSearchModel}`,
    responsesPayload,
  )

  const upstreamResult = await createOptimizedCopilotResponses(
    responsesPayload,
    {
      createResponses: webSearchFlowDependencies.createResponses,
      logger,
      requestOptions: {
        allowHttpFallback:
          endpointCapabilities.http && endpointCapabilities.websocket,
        vision,
        initiator,
        reasoningRecoverySessionId: options.reasoningRecoverySessionId,
        transport,
        subagentMarker: options.subagentMarker,
        requestId: options.requestId,
        sessionId: options.sessionId,
        signal: options.signal,
        compactType: options.compactType,
      },
      selectedModel,
    },
  )

  const recordUsage = createUsageRecorder(
    payload,
    options.sessionId,
    webSearchModel,
  )
  let result: ResponsesResult
  try {
    result =
      isWebSearchResponsesStream(upstreamResult) ?
        await collectResponsesStreamResult({
          errorMessagePrefix: "Web search responses stream",
          upstreamResponse: upstreamResult,
          logger,
        })
      : upstreamResult
  } catch (error) {
    if (error instanceof BufferedResponsesTerminalError) {
      recordBufferedResponsesTerminalFailure(recordUsage, error)
      throw createBufferedResponsesProtocolError(error)
    }
    throw error
  }

  const usage = normalizeWebSearchResponsesUsage(result)
  let reconstructed: ReturnType<typeof reconstructWebSearchResponse>
  try {
    reconstructed = reconstructWebSearchResponse(payload, result, {
      requestId: options.requestId,
    })
  } catch (error) {
    recordUsage(usage, getWebSearchUsageMetadata(result, "rejected"))
    throw error
  }
  recordUsage(usage, getWebSearchUsageMetadata(result, "mapped"))
  const { extract, response } = reconstructed

  debugJson(
    logger,
    `Web search via responses: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
    result,
  )

  if (!wantsStream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for (const event of buildSyntheticStreamEvents(response)) {
      const data = JSON.stringify(event)
      logger.debug(`Web search stream event`, data)
      await stream.writeSSE({
        event: event.type,
        data,
      })
    }
  })
}
