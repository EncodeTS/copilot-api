import type { ConsolaInstance } from "consola"
import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"
import type { Model } from "~/services/copilot/get-models"

import { debugJson, debugJsonTail, debugLazy } from "~/lib/logger"
import { state } from "~/lib/state"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
  getResponsesTransportForModel,
  getResponsesRequestOptions,
} from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  type Message,
} from "~/services/copilot/create-chat-completions"
import { createMessages } from "~/services/copilot/create-messages"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { prepareMessagesApiPayload } from "./preprocess"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "./stream-translation"

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2
const COPILOT_CONTEXT_CACHE_CONTROL = {
  type: "ephemeral",
} as const

export interface FlowBaseOptions {
  logger: ConsolaInstance
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

interface ResponsesFlowOptions extends FlowBaseOptions {
  selectedModel?: Model
}

interface MessagesFlowOptions extends FlowBaseOptions {
  anthropicBetaHeader?: string
  selectedModel?: Model
}

export const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: FlowBaseOptions,
) => {
  const { logger, subagentMarker, requestId, sessionId, compactType } = options
  const openAIPayload = translateToOpenAI(anthropicPayload)
  prepareCopilotChatCompletionsPayload(openAIPayload)
  debugJson(logger, "Translated OpenAI request payload:", openAIPayload)

  const response = await createChatCompletions(openAIPayload, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isNonStreaming(response)) {
    debugJson(logger, "Non-streaming response from Copilot:", response)
    const anthropicResponse = translateToAnthropic(response)
    debugJson(logger, "Translated Anthropic response:", anthropicResponse)
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }

    for await (const rawEvent of response) {
      debugJson(logger, "Copilot raw stream event:", rawEvent)
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => ["Translated Anthropic event:", eventData])
        await stream.writeSSE({
          event: event.type,
          data: eventData,
        })
      }
    }

    for (const event of flushPendingAnthropicStreamEvents(streamState)) {
      const eventData = JSON.stringify(event)
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
      await stream.writeSSE({
        event: event.type,
        data: eventData,
      })
    }
  })
}

export const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: ResponsesFlowOptions,
) => {
  const {
    logger,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)

  applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
  )

  compactInputByLatestCompaction(responsesPayload)

  debugJson(logger, "Translated Responses payload:", responsesPayload)

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const transport =
    getResponsesTransportForModel(selectedModel, { compactType }) ?? "http"
  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
    transport,
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState({
        toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
      })

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        const data = chunk.data
        if (!data) {
          continue
        }

        debugLazy(logger, () => ["Responses raw stream event:", data])

        const events = translateResponsesStreamEvent(
          JSON.parse(data) as ResponseStreamEvent,
          streamState,
        )
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => ["Translated Anthropic event:", eventData])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }

        if (streamState.messageCompleted) {
          logger.debug("Message completed, ending stream")
          break
        }
      }

      if (!streamState.messageCompleted) {
        logger.warn(
          "Responses stream ended without completion; sending error event",
        )
        const errorEvent = buildErrorEvent(
          "Responses stream ended without completion",
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    })
  }

  debugJsonTail(logger, "Non-streaming Responses result:", {
    value: response,
    tailLength: 400,
  })
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
    {
      toolSearchName: resolveBridgeToolSearchName(anthropicPayload.tools),
    },
  )
  debugJson(logger, "Translated Anthropic response:", anthropicResponse)
  return c.json(anthropicResponse)
}

export const handleWithMessagesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  options: MessagesFlowOptions,
) => {
  const {
    logger,
    anthropicBetaHeader,
    subagentMarker,
    selectedModel,
    requestId,
    sessionId,
    compactType,
  } = options

  prepareMessagesApiPayload(anthropicPayload, selectedModel)

  if (state.verbose) {
    consola.info(
      `[messages-api] thinking=${anthropicPayload.thinking?.type ?? "none"}`
        + ` | effort=${anthropicPayload.output_config?.effort ?? "default"}`
        + ` | temperature=${anthropicPayload.temperature ?? "unset"}`,
    )
  }

  debugJson(logger, "Translated Messages payload:", anthropicPayload)

  const response = await createMessages(anthropicPayload, anthropicBetaHeader, {
    subagentMarker,
    requestId,
    sessionId,
    compactType,
  })

  if (isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Messages API)")
    return streamSSE(c, async (stream) => {
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
        await stream.writeSSE({
          event: eventName,
          data,
        })
      }
    })
  }

  debugJsonTail(logger, "Non-streaming Messages result:", {
    value: response,
    tailLength: 400,
  })
  return c.json(response)
}

export const prepareCopilotChatCompletionsPayload = (
  payload: ChatCompletionsPayload,
): void => {
  applyCopilotContextCache(payload)
}

const applyCopilotContextCache = (payload: ChatCompletionsPayload): void => {
  const messageIndexes = selectCopilotContextCacheMessageIndexes(
    payload.messages,
  )
  for (const messageIndex of messageIndexes) {
    const message = payload.messages[messageIndex]
    message.copilot_cache_control = { ...COPILOT_CONTEXT_CACHE_CONTROL }
  }
}

const selectCopilotContextCacheMessageIndexes = (
  messages: Array<Message>,
): Array<number> => {
  const systemIndexes = messages
    .flatMap((message, index) =>
      message.role === "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .slice(0, COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT)
  const reverseNonSystemIndexes = messages
    .flatMap((message, index) =>
      message.role !== "system" && isCopilotContextCacheEligible(message) ?
        [index]
      : [],
    )
    .reverse()
    .slice(0, COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT)

  return uniqueIndexes([...systemIndexes, ...reverseNonSystemIndexes]).sort(
    (a, b) => a - b,
  )
}

const isCopilotContextCacheEligible = (message: Message): boolean => {
  if (typeof message.content === "string") {
    return message.content.length > 0
  }

  return Array.isArray(message.content) && message.content.length > 0
}

const uniqueIndexes = (indexes: Array<number>): Array<number> => [
  ...new Set(indexes),
]

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
