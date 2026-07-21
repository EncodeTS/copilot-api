import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import {
  isResponsesApiWebSearchEnabled as isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
} from "~/lib/config"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  logDiagnosticEvent,
} from "~/lib/logger"
import { observeCopilotResponsesMetadata } from "~/lib/copilot-rate-limit"
import { responsesDiagnosticsLogger } from "~/lib/responses-diagnostic-logger"
import { summarizeResponsesPayload } from "~/lib/responses-diagnostics"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import type { ResponsesStreamSessionFrame } from "~/lib/responses-stream-session"
import { normalizeGatewayReasoningEffort } from "~/lib/reasoning-effort"
import {
  routeProviderModelAlias,
  type ProviderModelRouter,
} from "~/routes/provider/model-router"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import type { SubagentMarker } from "~/lib/subagent"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixParsedStreamIds } from "./stream-id-sync"
import {
  projectResponsesSessionFrame,
  relayResponsesStreamSession,
} from "./stream-session-adapter"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "./utils"
import { createOptimizedCopilotResponses } from "./optimized-create"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
}

export interface ResponsesHandlerComposition {
  providerModelRouter?: ProviderModelRouter
}

export const handleResponses = async (
  c: Context,
  composition: ResponsesHandlerComposition = {},
) => {
  const payload = await c.req.json<ResponsesPayload>()
  if (
    typeof payload.reasoning === "object"
    && payload.reasoning !== null
    && Object.hasOwn(payload.reasoning, "effort")
    && payload.reasoning.effort !== null
  ) {
    const effort = normalizeGatewayReasoningEffort(payload.reasoning.effort)
    if (!effort) {
      return c.json(
        {
          error: {
            code: "unsupported_value",
            message: "Unsupported Responses reasoning effort",
            param: "reasoning.effort",
            type: "invalid_request_error",
          },
        },
        400,
      )
    }
    payload.reasoning.effort = effort
  }
  const requestedModel = payload.model
  payload.model = responsesHandlerDependencies.resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerResponse = await (
    composition.providerModelRouter?.route ?? routeProviderModelAlias
  )(c, {
    endpoint: "responses",
    payload,
  })
  if (providerResponse) return providerResponse

  const unsupportedIntent = getUnsupportedCopilotResponsesIntent(payload)
  if (unsupportedIntent) {
    return c.json(
      {
        error: {
          code: "unsupported_value",
          message: `GitHub Copilot Responses does not support ${unsupportedIntent.label}; the request was not modified.`,
          param: unsupportedIntent.param,
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  debugJsonTail(logger, "Responses request payload:", {
    value: payload,
    tailLength: 2_000,
  })

  const subagentMarker = getCodexResponsesSubagentMarker(c)
  if (subagentMarker) {
    debugJson(logger, "Detected Codex subagent headers:", subagentMarker)
  }

  const incomingSessionId = getIncomingResponsesSessionId(c)
  const sessionId = incomingSessionId ? getUUID(incomingSessionId) : undefined
  const requestId = generateRequestIdFromPayload(
    { messages: payload.input },
    sessionId,
  )
  logger.debug("Generated request ID:", requestId)

  const fallbackSessionId = sessionId ?? getUUID(requestId)
  logger.debug("Extracted session ID:", fallbackSessionId)
  const recordUsage = createCopilotTokenUsageRecorder({
    endpoint: "responses",
    fallbackSessionId,
    model: payload.model,
    outcome: "completed",
  })

  if (!responsesHandlerDependencies.isResponsesApiWebSearchEnabled()) {
    removeWebSearchTool(payload)
  }

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )
  const responsesTransport = getResponsesTransportForModel(selectedModel)
  const endpointCapabilities = getResponsesEndpointCapabilities(selectedModel)

  if (!responsesTransport) {
    return c.json(
      {
        error: {
          message:
            "This model does not support the responses endpoint. Please choose a different model.",
          type: "invalid_request_error",
        },
      },
      400,
    )
  }

  // Smaller than the client compaction threshold, use server-side compaction to maintain cache hit rate
  const contextManagementDecision = applyResponsesApiContextManagement(
    payload,
    selectedModel?.capabilities.limits,
    {
      compactThresholdRatio: 0.8,
      source: "responses",
    },
  )
  if (contextManagementDecision.shouldPruneInput) {
    compactInputByLatestCompaction(payload)
  }

  const requestDiagnostic = summarizeResponsesPayload(payload, {
    includePayloadBytes: false,
  })
  logDiagnosticEvent(responsesDiagnosticsLogger, "info", "responses.request", {
    compactThreshold: requestDiagnostic.compactThreshold,
    contextOwner: contextManagementDecision.owner,
    inputItems: requestDiagnostic.inputItems,
    model: requestDiagnostic.model,
    requestId,
    requestedModel,
    sessionId: fallbackSessionId,
    stream: requestDiagnostic.stream,
    transport: responsesTransport,
  })
  const modelLimits = selectedModel?.capabilities.limits
  logDiagnosticEvent(
    responsesDiagnosticsLogger,
    "debug",
    "responses.context_management",
    {
      compactThreshold: requestDiagnostic.compactThreshold,
      contextInjected: contextManagementDecision.injected,
      contextOwner: contextManagementDecision.owner,
      maxContextTokens: modelLimits?.max_context_window_tokens,
      maxOutputTokens: modelLimits?.max_output_tokens,
      promptLimitTokens: modelLimits?.max_prompt_tokens,
      requestId,
      sessionId: fallbackSessionId,
      shouldPruneInput: contextManagementDecision.shouldPruneInput,
    },
  )
  debugJsonTail(logger, "Translated Responses payload:", {
    value: payload,
    tailLength: 2_000,
  })

  const { vision, initiator: inferredInitiator } =
    getResponsesRequestOptions(payload)
  const initiator = subagentMarker ? "agent" : inferredInitiator

  const response = await createOptimizedCopilotResponses(payload, {
    createResponses: responsesHandlerDependencies.createResponses,
    logger,
    requestOptions: {
      allowHttpFallback:
        responsesTransport === "websocket" && endpointCapabilities.http,
      vision,
      initiator,
      reasoningRecoverySessionId: sessionId,
      subagentMarker,
      requestId,
      sessionId: fallbackSessionId,
      signal: c.req.raw.signal,
      transport: responsesTransport,
    },
    selectedModel,
  })

  if (isStreamingRequested(payload) && isAsyncIterable(response)) {
    logger.debug("Forwarding native Responses stream")
    return streamSSE(c, async (stream) => {
      const idTracker = createStreamIdTracker()
      await relayResponsesStreamSession({
        eofErrorMessage: "Responses stream ended without a terminal event",
        flow: "responses",
        logger,
        observeFrame: (frame) => {
          debugJsonTail(logger, "Responses stream chunk:", {
            value: frame.wire,
            tailLength: 1_000,
          })
          if (frame.kind === "event") {
            observeCopilotResponsesMetadata(frame.event)
          }
          if (frame.kind === "unknown") {
            observeCopilotResponsesMetadata(frame.parsed)
          }
        },
        output: stream,
        projectFrame: (frame) => projectNativeResponsesFrame(frame, idTracker),
        recordUsage,
        signal: c.req.raw.signal,
        source: response,
        transport: responsesTransport,
      })
    })
  }

  debugJsonTail(logger, "Forwarding native Responses result:", {
    value: response,
    tailLength: 400,
  })
  const result = response as ResponsesResult
  recordUsage({
    ...normalizeResponsesUsage(result.usage),
    total_nano_aiu: normalizeOptionalToken(
      result.copilot_usage?.total_nano_aiu,
    ),
  })
  return c.json(result)
}

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const isStreamingRequested = (payload: ResponsesPayload): boolean =>
  Boolean(payload.stream)

const projectNativeResponsesFrame = (
  frame: ResponsesStreamSessionFrame,
  idTracker: ReturnType<typeof createStreamIdTracker>,
) => {
  const message = projectResponsesSessionFrame(frame)
  if (frame.kind !== "event" || !message) return message
  message.data = fixParsedStreamIds(
    message.data,
    frame.event as unknown as ResponseStreamEvent,
    idTracker,
    frame.wire.event,
  )
  return message
}

const removeWebSearchTool = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) return

  payload.tools = payload.tools.filter((t) => {
    return t.type !== "web_search"
  })
}

const getUnsupportedCopilotResponsesIntent = (
  payload: ResponsesPayload,
): { label: string; param: string } | undefined => {
  if (payload.background === true) {
    return { label: "background", param: "background" }
  }
  if (
    payload.tools?.some(
      (tool) => (tool as { type?: unknown }).type === "image_generation",
    )
  ) {
    return { label: "image_generation", param: "tools" }
  }
  return undefined
}

const getIncomingResponsesSessionId = (c: Context): string | undefined =>
  getTrimmedHeader(c, "session-id") ?? getTrimmedHeader(c, "x-session-id")

const codexSubagentHeaderValues = new Set([
  "collab_spawn",
  "compact",
  "memory_consolidation",
  "review",
])

const getCodexResponsesSubagentMarker = (c: Context): SubagentMarker | null => {
  const agentType = getTrimmedHeader(c, "x-openai-subagent")
  if (!agentType || !codexSubagentHeaderValues.has(agentType)) {
    return null
  }

  const threadId = getTrimmedHeader(c, "thread-id")
  const rootSessionId = getIncomingResponsesSessionId(c)
  const parentThreadId = getTrimmedHeader(c, "x-codex-parent-thread-id")
  if (!threadId && !rootSessionId && !parentThreadId) {
    return null
  }

  const agentId = threadId ?? parentThreadId ?? rootSessionId ?? agentType

  return {
    agent_id: agentId,
    agent_type: agentType,
    session_id: threadId ?? rootSessionId ?? agentId,
  }
}

const getTrimmedHeader = (c: Context, name: string): string | undefined => {
  const value = c.req.header(name)?.trim()
  return value || undefined
}
