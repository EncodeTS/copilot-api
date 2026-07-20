import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { debugJson, debugJsonTail, debugLazy } from "~/lib/logger"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import { getResponsesEndpointCapabilities } from "~/lib/responses-capabilities"
import {
  createCopilotTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type TokenUsageEndpoint,
  type UsageTokens,
} from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
import { getResponsesResultFailureMessage } from "~/routes/messages/responses-result"
import { translateResponsesResultToAnthropic } from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import { createOptimizedCopilotResponses } from "~/routes/responses/optimized-create"
import {
  createChatCompletions as createCopilotChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createMessages as createCopilotMessages } from "~/services/copilot/create-messages"
import {
  createResponses as createCopilotResponses,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamEventData,
  type AnthropicStreamState,
  type CopilotUsage,
} from "./anthropic-types"
export { prepareCopilotChatCompletionsPayload } from "~/routes/messages/copilot-chat-payload"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"
import { consumeResponsesStream } from "./responses-stream-consumer"
import { emitAnthropicStreamError } from "./stream-error"

const createAnthropicErrorBody = (
  message: string,
  type: "api_error" | "invalid_request_error" = "api_error",
) => ({
  type: "error" as const,
  error: {
    type,
    message,
  },
})

export const messagesApiFlowDependencies = {
  createChatCompletions: createCopilotChatCompletions,
  createMessages: createCopilotMessages,
  createResponses: createCopilotResponses,
}

export interface FlowBaseOptions {
  logger: ConsolaInstance
  reasoningRecoverySessionId?: string
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  signal?: AbortSignal
  compactType?: CompactType
}

export interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

export type MessagesFlowOptions = FlowBaseOptions & {
  anthropicBetaHeader?: string
}

export type ChatCompletionsFlowOptions = FlowBaseOptions

export const handlePreparedChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ChatCompletionsFlowOptions,
  openAIPayload: ChatCompletionsPayload,
) => {
  const { logger, subagentMarker, requestId, sessionId, signal, compactType } =
    options
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "chat_completions",
    fallbackSessionId: sessionId,
    model: openAIPayload.model,
    payload: anthropicPayload,
  })
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await messagesApiFlowDependencies.createChatCompletions(
    openAIPayload,
    {
      subagentMarker,
      requestId,
      sessionId,
      signal,
      compactType,
    },
  )

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    recordUsage({
      ...normalizeOpenAIUsage(response.usage),
      total_nano_aiu: normalizeOptionalToken(
        response.copilot_usage?.total_nano_aiu,
      ),
    })
    if (response.choices.some((choice) => choice.finish_reason === "error")) {
      return c.json(
        createAnthropicErrorBody(
          "Chat Completions upstream ended with finish_reason=error",
        ),
        502,
      )
    }

    const anthropicResponse = translateToAnthropic(response, {
      includeThinking: anthropicPayload.thinking?.type !== "disabled",
    })
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamStartedAt = Date.now()
    let usage: UsageTokens = {}
    let eventCount = 0
    let lastEventType: string | null = null
    let finishReasonSeen = false
    let terminalSeen = false
    let streamFailed = false
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      emitThinking: anthropicPayload.thinking?.type !== "disabled",
    }

    try {
      for await (const rawEvent of response) {
        debugJson(logger, "Copilot raw stream event:", rawEvent)
        if (rawEvent.data === "[DONE]") {
          break
        }

        if (!rawEvent.data) {
          continue
        }

        const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
        if (chunk.choices.some((choice) => choice.finish_reason === "error")) {
          streamFailed = true
          await emitAnthropicStreamError(stream, logger, {
            diagnostics: {
              elapsedMs: Date.now() - streamStartedAt,
              eventCount,
              flow: "chat_completions",
              lastEventType,
              retryCount: 0,
              terminalSeen,
              transport: "http",
            },
            error: new Error(
              "Chat Completions upstream ended with finish_reason=error",
            ),
            flow: "chat_completions",
            signal,
          })
          break
        }
        finishReasonSeen ||= chunk.choices.some((choice) =>
          Boolean(choice.finish_reason),
        )
        if (chunk.usage || chunk.copilot_usage) {
          usage = {
            ...normalizeOpenAIUsage(chunk.usage),
            total_nano_aiu: normalizeOptionalToken(
              chunk.copilot_usage?.total_nano_aiu,
            ),
          }
        }
        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
          eventCount += 1
          lastEventType = event.type
          terminalSeen ||= event.type === "message_stop"
        }
      }

      if (!finishReasonSeen && !streamFailed) {
        await emitAnthropicStreamError(stream, logger, {
          diagnostics: {
            elapsedMs: Date.now() - streamStartedAt,
            eventCount,
            flow: "chat_completions",
            lastEventType,
            retryCount: 0,
            terminalSeen,
            transport: "http",
          },
          error: new Error(
            "Chat Completions stream ended without a terminal event",
          ),
          flow: "chat_completions",
          signal,
        })
      } else if (!streamFailed) {
        for (const event of flushPendingAnthropicStreamEvents(streamState)) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
          eventCount += 1
          lastEventType = event.type
        }
      }
    } catch (error) {
      await emitAnthropicStreamError(stream, logger, {
        diagnostics: {
          elapsedMs: Date.now() - streamStartedAt,
          eventCount,
          flow: "chat_completions",
          lastEventType,
          retryCount: 0,
          terminalSeen,
          transport: "http",
        },
        error,
        flow: "chat_completions",
        signal,
      })
    }

    recordUsage(usage)
  })
}

export const handlePreparedResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
  responsesPayload: Parameters<typeof createOptimizedCopilotResponses>[0],
  transport: "http" | "websocket",
) => {
  const { logger, selectedModel, ...requestOptions } = options
  const recordUsage = createCopilotUsageRecorder({
    endpoint: "responses",
    fallbackSessionId: requestOptions.sessionId,
    model: responsesPayload.model,
    payload: anthropicPayload,
  })
  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const endpointCapabilities = getResponsesEndpointCapabilities(selectedModel)
  debugJson(logger, "Translated Responses payload:", responsesPayload)
  const response = await createOptimizedCopilotResponses(responsesPayload, {
    createResponses: messagesApiFlowDependencies.createResponses,
    logger,
    requestOptions: {
      allowHttpFallback: transport === "websocket" && endpointCapabilities.http,
      vision,
      initiator,
      transport,
      ...requestOptions,
    },
    selectedModel,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, (stream) =>
      consumeResponsesStream({
        kind: "copilot",
        logger,
        output: stream,
        payload: anthropicPayload,
        recordUsage,
        signal: requestOptions.signal,
        transport,
        upstreamResponse: response,
      }),
    )
  }

  const responsesResult = response as ResponsesResult
  debugJson(logger, "Non-streaming Responses result:", responsesResult)
  recordUsage({
    ...normalizeResponsesUsage(responsesResult.usage),
    total_nano_aiu: normalizeOptionalToken(
      responsesResult.copilot_usage?.total_nano_aiu,
    ),
  })
  const failureMessage = getResponsesResultFailureMessage(responsesResult)
  if (failureMessage) {
    return c.json(createAnthropicErrorBody(failureMessage), 502)
  }

  const anthropicResponse = translateResponsesResultToAnthropic(
    responsesResult,
    {
      includeThinking: anthropicPayload.thinking?.type !== "disabled",
      toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
    },
  )
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return c.json(anthropicResponse)
}

export const handlePreparedMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    requestId,
    sessionId,
    signal,
    compactType,
  } = options

  const recordUsage = createCopilotUsageRecorder({
    endpoint: "messages",
    fallbackSessionId: sessionId,
    model: anthropicPayload.model,
    payload: anthropicPayload,
  })

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await messagesApiFlowDependencies.createMessages(
    anthropicPayload,
    anthropicBetaHeader,
    {
      subagentMarker,
      requestId,
      sessionId,
      signal,
      compactType,
    },
  )

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
      const streamStartedAt = Date.now()
      let usage: UsageTokens = {}
      let eventCount = 0
      let lastEventType: string | null = null
      let terminalSeen = false

      try {
        for await (const event of response) {
          const eventName = event.event
          const data = event.data ?? ""
          if (data === "[DONE]") {
            break
          }
          if (!data) {
            continue
          }
          debugLazy(logger, () => ["Messages raw stream event:", data])
          const parsedEvent = parseAnthropicStreamEvent(data)
          if (parsedEvent?.type === "message_start") {
            usage = mergeAnthropicUsage(usage, {
              ...normalizeAnthropicUsage(parsedEvent.message.usage),
              ...normalizeCopilotUsage(parsedEvent.message.copilot_usage),
            })
          } else if (parsedEvent?.type === "message_delta") {
            usage = mergeAnthropicUsage(usage, {
              ...normalizeAnthropicUsage(parsedEvent.usage),
              ...normalizeCopilotUsage(parsedEvent.copilot_usage),
            })
          } else if (parsedEvent?.type === "message_stop") {
            terminalSeen = true
          }
          await stream.writeSSE({
            event: eventName,
            data,
          })
          eventCount += 1
          lastEventType = parsedEvent?.type ?? eventName ?? lastEventType
        }

        if (!terminalSeen) {
          await emitAnthropicStreamError(stream, logger, {
            diagnostics: {
              elapsedMs: Date.now() - streamStartedAt,
              eventCount,
              flow: "messages",
              lastEventType,
              retryCount: 0,
              terminalSeen,
              transport: "http",
            },
            error: new Error("Messages stream ended without a terminal event"),
            flow: "messages",
            signal,
          })
        }
      } catch (error) {
        await emitAnthropicStreamError(stream, logger, {
          diagnostics: {
            elapsedMs: Date.now() - streamStartedAt,
            eventCount,
            flow: "messages",
            lastEventType,
            retryCount: 0,
            terminalSeen,
            transport: "http",
          },
          error,
          flow: "messages",
          signal,
        })
      }

      recordUsage(usage)
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  recordUsage({
    ...normalizeAnthropicUsage(response.usage),
    ...normalizeCopilotUsage(response.copilot_usage),
  })
  return c.json(response)
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createCopilotChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const createCopilotUsageRecorder = (options: {
  endpoint: TokenUsageEndpoint
  fallbackSessionId?: string
  model: string
  payload: AnthropicMessagesPayload
}): ((usage: UsageTokens) => void) =>
  createCopilotTokenUsageRecorder({
    endpoint: options.endpoint,
    fallbackSessionId: options.fallbackSessionId,
    model: options.model,
    sessionId: getMetadataSessionId(options.payload),
  })

const getMetadataSessionId = (
  payload: AnthropicMessagesPayload,
): string | null => parseUserIdMetadata(payload.metadata?.user_id).sessionId

const normalizeCopilotUsage = (
  copilotUsage: CopilotUsage | null | undefined,
): UsageTokens => ({
  total_nano_aiu: normalizeOptionalToken(copilotUsage?.total_nano_aiu),
})

const parseAnthropicStreamEvent = (
  data: string,
): AnthropicStreamEventData | null => {
  try {
    return JSON.parse(data) as AnthropicStreamEventData
  } catch {
    return null
  }
}
