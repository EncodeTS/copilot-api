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
import { responsesDiagnosticsLogger } from "~/lib/responses-diagnostic-logger"
import { summarizeResponsesPayload } from "~/lib/responses-diagnostics"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import { routeProviderModelAlias } from "~/routes/provider/model-router"
import { state } from "~/lib/state"
import {
  createCopilotTokenUsageRecorder,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { generateRequestIdFromPayload, getUUID } from "~/lib/utils"
import type { SubagentMarker } from "~/lib/subagent"
import {
  createResponses as createCopilotResponses,
  type ResponsesPayload,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import { createStreamIdTracker, fixStreamIds } from "./stream-id-sync"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "./utils"
import { createOptimizedCopilotResponses } from "./optimized-create"
import { emitResponsesStreamError } from "./stream-error"
import consola from "consola"

const logger = createHandlerLogger("responses-handler")

export const responsesHandlerDependencies = {
  createResponses: createCopilotResponses,
  isResponsesApiWebSearchEnabled: isConfiguredResponsesApiWebSearchEnabled,
  resolveMappedModel,
}

export const handleResponses = async (c: Context) => {
  const payload = await c.req.json<ResponsesPayload>()
  const requestedModel = payload.model
  payload.model = responsesHandlerDependencies.resolveMappedModel(payload.model)
  if (payload.model !== requestedModel) {
    consola.debug(
      `Resolved model mapping: ${requestedModel} -> ${payload.model}`,
    )
  }

  const providerResponse = await routeProviderModelAlias(c, {
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
      const streamStartedAt = Date.now()
      let usage: UsageTokens = {}
      let eventCount = 0
      let lastEventType: string | null = null
      let terminalSeen = false

      try {
        for await (const chunk of response) {
          debugJsonTail(logger, "Responses stream chunk:", {
            value: chunk,
            tailLength: 1_000,
          })
          const parsedEvent = parseResponsesStreamEvent(chunk)
          const isTerminal = isTerminalResponsesStreamEvent(parsedEvent)
          if (isTerminal) {
            terminalSeen = true
          }
          if (
            parsedEvent?.type === "response.completed"
            || parsedEvent?.type === "response.failed"
            || parsedEvent?.type === "response.incomplete"
          ) {
            usage = {
              ...normalizeResponsesUsage(parsedEvent.response.usage),
              total_nano_aiu: normalizeOptionalToken(
                parsedEvent.copilot_usage?.total_nano_aiu,
              ),
            }
          }

          const processedData = fixStreamIds(
            (chunk as { data?: string }).data ?? "",
            (chunk as { event?: string }).event,
            idTracker,
          )

          await stream.writeSSE({
            id: (chunk as { id?: string }).id,
            event: (chunk as { event?: string }).event,
            data: processedData,
          })
          eventCount += 1
          lastEventType =
            parsedEvent?.type
            ?? (chunk as { event?: string }).event
            ?? lastEventType

          if (isTerminal) {
            break
          }
        }
      } catch (error) {
        if (!terminalSeen) {
          await emitResponsesStreamError(stream, logger, error, {
            diagnostics: {
              elapsedMs: Date.now() - streamStartedAt,
              eventCount,
              flow: "responses",
              lastEventType,
              retryCount: 0,
              terminalSeen,
              transport: responsesTransport,
            },
            signal: c.req.raw.signal,
          })
        }
        recordUsage(usage)
        return
      }

      if (!terminalSeen && !c.req.raw.signal.aborted) {
        await emitResponsesStreamError(
          stream,
          logger,
          new Error("Responses stream ended without a terminal event"),
          {
            diagnostics: {
              elapsedMs: Date.now() - streamStartedAt,
              eventCount,
              flow: "responses",
              lastEventType,
              retryCount: 0,
              terminalSeen,
              transport: responsesTransport,
            },
            signal: c.req.raw.signal,
          },
        )
      }

      recordUsage(usage)
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

const parseResponsesStreamEvent = (
  chunk: unknown,
): ResponseStreamEvent | null => {
  const data = (chunk as { data?: string }).data
  if (!data || data === "[DONE]") {
    return null
  }

  try {
    return JSON.parse(data) as ResponseStreamEvent
  } catch {
    return null
  }
}

const isTerminalResponsesStreamEvent = (
  event: ResponseStreamEvent | null,
): boolean =>
  event?.type === "response.completed"
  || event?.type === "response.failed"
  || event?.type === "response.incomplete"
  || event?.type === "error"

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
