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
import { webSearchCarrierSanitizer } from "./carrier-sanitizer"

export * from "./policy"
export * from "./reconstruction"

type CreateWebSearchUsageRecorder = (
  payload: AnthropicMessagesPayload,
  sessionId?: string,
  webSearchModel?: string,
) => TokenUsageRecorder

export interface WebSearchFlow {
  handleViaResponses: (
    c: Context,
    payload: AnthropicMessagesPayload,
    options: WebSearchFlowOptions,
  ) => Promise<Response>
  tryHandle: (
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
  ) => Promise<Response | null>
}

export interface WebSearchFlowComposition {
  createResponses?: typeof createCopilotResponses
  createUsageRecorder?: CreateWebSearchUsageRecorder
  findEndpointModel?: typeof findEndpointModel
  getMessageApiWebSearchModel?: typeof getMessageApiWebSearchModel
  getResponsesTransportForModel?: typeof getResponsesTransportForModel
  isResponsesApiWebSearchEnabled?: typeof isResponsesApiWebSearchEnabled
}

interface WebSearchFlowDependencies {
  createResponses: typeof createCopilotResponses
  createUsageRecorder: CreateWebSearchUsageRecorder
  findEndpointModel: typeof findEndpointModel
  getMessageApiWebSearchModel: typeof getMessageApiWebSearchModel
  getResponsesTransportForModel: typeof getResponsesTransportForModel
  isResponsesApiWebSearchEnabled: typeof isResponsesApiWebSearchEnabled
}

const createDefaultWebSearchFlowDependencies =
  (): WebSearchFlowDependencies => ({
    createResponses: createCopilotResponses,
    createUsageRecorder: (
      payload,
      sessionId,
      webSearchModel,
    ): TokenUsageRecorder =>
      createCopilotTokenUsageRecorder({
        endpoint: "responses",
        fallbackSessionId: sessionId,
        model: webSearchModel ?? payload.model,
        outcome: "completed",
        sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
      }),
    findEndpointModel,
    getMessageApiWebSearchModel,
    getResponsesTransportForModel,
    isResponsesApiWebSearchEnabled,
  })

export const createWebSearchFlow = (
  composition: WebSearchFlowComposition = {},
): WebSearchFlow => {
  const defaults = createDefaultWebSearchFlowDependencies()
  const dependencies = Object.freeze<WebSearchFlowDependencies>({
    createResponses: composition.createResponses ?? defaults.createResponses,
    createUsageRecorder:
      composition.createUsageRecorder ?? defaults.createUsageRecorder,
    findEndpointModel:
      composition.findEndpointModel ?? defaults.findEndpointModel,
    getMessageApiWebSearchModel:
      composition.getMessageApiWebSearchModel
      ?? defaults.getMessageApiWebSearchModel,
    getResponsesTransportForModel:
      composition.getResponsesTransportForModel
      ?? defaults.getResponsesTransportForModel,
    isResponsesApiWebSearchEnabled:
      composition.isResponsesApiWebSearchEnabled
      ?? defaults.isResponsesApiWebSearchEnabled,
  })

  const flow: WebSearchFlow = {
    handleViaResponses: (c, payload, options) =>
      handleWebSearchViaResponsesWithDependencies(
        c,
        payload,
        options,
        dependencies,
      ),
    tryHandle: (c, payload, options) =>
      tryHandleWebSearchWithDependencies(c, payload, options, dependencies),
  }
  return Object.freeze(flow)
}

export interface WebSearchFlowOptions {
  logger: ConsolaInstance
  reasoningRecoverySessionId?: string
  subagentMarker?: SubagentMarker | null
  /** GPT (Responses-capable) model the web search request is switched to. */
  webSearchModel: string
  requestId?: string
  sessionId?: string
  signal?: AbortSignal
  compactType?: CompactType
}

const isWebSearchResponsesStream = (value: unknown): value is ResponsesStream =>
  Boolean(value)
  && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"

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
  composition: WebSearchFlowComposition = {},
): Promise<Response | null> =>
  await createWebSearchFlow(composition).tryHandle(c, payload, options)

const tryHandleWebSearchWithDependencies = async (
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
  dependencies: WebSearchFlowDependencies,
): Promise<Response | null> => {
  if (!hasWebSearchServerTool(payload)) return null

  normalizeSystemMessages(payload)

  const route = resolveWebSearchRoute(payload, {
    webSearchModel: dependencies.getMessageApiWebSearchModel(),
    responsesWebSearchEnabled: dependencies.isResponsesApiWebSearchEnabled(),
  })

  if (route.kind === "provider") {
    payload.model = route.alias.model
    return await options.forwardToProvider(c, payload, route.alias.provider)
  }

  if (route.kind === "responses") {
    const reasoningRecoverySessionId = getRootSessionId(payload, c)
    return await handleWebSearchViaResponsesWithDependencies(
      c,
      payload,
      {
        subagentMarker: null,
        webSearchModel: route.model,
        reasoningRecoverySessionId,
        signal: c.req.raw.signal,
        compactType: 0,
        logger: options.logger,
      },
      dependencies,
    )
  }

  return createWebSearchUnsupportedResponse(c, route.message)
}

/** Execute the bounded Responses fallback and adapt its result to Messages. */
export const handleWebSearchViaResponses = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: WebSearchFlowOptions,
  composition: WebSearchFlowComposition = {},
): Promise<Response> =>
  await createWebSearchFlow(composition).handleViaResponses(c, payload, options)

const handleWebSearchViaResponsesWithDependencies = async (
  c: Context,
  payload: AnthropicMessagesPayload,
  options: WebSearchFlowOptions,
  dependencies: WebSearchFlowDependencies,
): Promise<Response> => {
  const { logger, webSearchModel } = options
  const wantsStream = Boolean(payload.stream)
  const selectedModel: Model | undefined =
    dependencies.findEndpointModel(webSearchModel)
  const carrierSanitization = webSearchCarrierSanitizer.sanitize(payload, {
    destination: "responses",
    canonicalTarget: {
      adapter: "copilot-responses",
      provider: "copilot",
      model: selectedModel?.id ?? webSearchModel.trim(),
    },
  })
  const requestId =
    options.requestId
    ?? generateRequestIdFromPayload(payload, options.reasoningRecoverySessionId)
  let sessionId = options.sessionId ?? options.reasoningRecoverySessionId
  if (!sessionId) sessionId = getUUID(requestId)
  applyWebSearchFallbackHeaders(c, payload, logger)

  const responsesPayload = prepareWebSearchResponsesPayload(payload, {
    model: webSearchModel,
    restoredWebSearchTurns: carrierSanitization.restoredTurns,
    subagentAgentId: options.subagentMarker?.agent_id,
  })
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
    dependencies.getResponsesTransportForModel(selectedModel, {
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
      createResponses: dependencies.createResponses,
      logger,
      requestOptions: {
        allowHttpFallback:
          endpointCapabilities.http && endpointCapabilities.websocket,
        vision,
        initiator,
        reasoningRecoverySessionId: options.reasoningRecoverySessionId,
        transport,
        subagentMarker: options.subagentMarker,
        requestId,
        sessionId,
        signal: options.signal,
        compactType: options.compactType,
      },
      selectedModel,
    },
  )

  const recordUsage = dependencies.createUsageRecorder(
    payload,
    sessionId,
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
          signal: options.signal,
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
      carrierSource: {
        destination: "responses",
        adapter: "copilot-responses",
        provider: "copilot",
        model: selectedModel?.id ?? responsesPayload.model,
      },
      requestId,
      resumedPendingServerToolUseIds:
        carrierSanitization.resumedPendingServerToolUseIds,
      turnPhase: carrierSanitization.turnPhase,
    })
  } catch (error) {
    recordUsage(usage, getWebSearchUsageMetadata(result, "rejected"))
    throw error
  }
  recordUsage(usage, getWebSearchUsageMetadata(result, "mapped"))
  const { extract, response } = reconstructed
  c.header("x-copilot-api-web-search-carrier", reconstructed.carrierMode)

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
      logger.debug("Web search stream event", event.type)
      await stream.writeSSE({
        event: event.type,
        data,
      })
    }
  })
}
