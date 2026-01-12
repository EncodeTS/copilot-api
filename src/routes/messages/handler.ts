import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getSmallModel } from "~/lib/config"
import { createHandlerLogger } from "~/lib/logger"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import { getResponsesRequestOptions } from "~/routes/responses/utils"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesResult,
  type ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

const logger = createHandlerLogger("messages-handler")

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  logger.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  // fix claude code 2.0.28+ warmup request consume premium request, forcing small model if no tools are used
  // set "CLAUDE_CODE_SUBAGENT_MODEL": "you small model" also can avoid this
  const anthropicBeta = c.req.header("anthropic-beta")
  const noTools = !anthropicPayload.tools || anthropicPayload.tools.length === 0
  if (anthropicBeta && noTools) {
    anthropicPayload.model = getSmallModel()
  }

  // fix claude code skill tool_result content and skill text are separated, need to merge them,
  // otherwise it will consume premium request
  // e.g. {"role":"user","content":[{"type":"tool_result","tool_use_id":"call_xOTodtnTctlfEHj983qwWNhk","content":"Launching skill: xxxx"},{"type":"text","text":"xxx"}]}
  mergeToolResultForClaude(anthropicBeta, anthropicPayload)

  const useResponsesApi = shouldUseResponsesApi(anthropicPayload.model)

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (useResponsesApi) {
    return await handleWithResponsesApi(c, anthropicPayload)
  }

  return await handleWithChatCompletions(c, anthropicPayload)
}

const RESPONSES_ENDPOINT = "/responses"

const handleWithChatCompletions = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) => {
  const openAIPayload = translateToOpenAI(anthropicPayload)
  logger.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    logger.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    logger.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  logger.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      logger.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        logger.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const handleWithResponsesApi = async (
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
) => {
  const responsesPayload =
    translateAnthropicMessagesToResponsesPayload(anthropicPayload)
  logger.debug(
    "Translated Responses payload:",
    JSON.stringify(responsesPayload),
  )

  const { vision, initiator } = getResponsesRequestOptions(responsesPayload)
  const response = await createResponses(responsesPayload, {
    vision,
    initiator,
  })

  if (responsesPayload.stream && isAsyncIterable(response)) {
    logger.debug("Streaming response from Copilot (Responses API)")
    return streamSSE(c, async (stream) => {
      const streamState = createResponsesStreamState()

      for await (const chunk of response) {
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: "" })
          continue
        }

        const data = chunk.data
        if (!data) {
          continue
        }

        logger.debug("Responses raw stream event:", data)

        const events = translateResponsesStreamEvent(
          JSON.parse(data) as ResponseStreamEvent,
          streamState,
        )
        for (const event of events) {
          const eventData = JSON.stringify(event)
          logger.debug("Translated Anthropic event:", eventData)
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

  logger.debug(
    "Non-streaming Responses result:",
    JSON.stringify(response).slice(-400),
  )
  const anthropicResponse = translateResponsesResultToAnthropic(
    response as ResponsesResult,
  )
  logger.debug(
    "Translated Anthropic response:",
    JSON.stringify(anthropicResponse),
  )
  return c.json(anthropicResponse)
}

const shouldUseResponsesApi = (modelId: string): boolean => {
  const selectedModel = state.models?.data.find((model) => model.id === modelId)
  return (
    selectedModel?.supported_endpoints?.includes(RESPONSES_ENDPOINT) ?? false
  )
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isAsyncIterable = <T>(value: unknown): value is AsyncIterable<T> =>
  Boolean(value)
  && typeof (value as AsyncIterable<T>)[Symbol.asyncIterator] === "function"

const mergeToolResultForClaude = (
  anthropicBeta: string | undefined,
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  if (anthropicBeta) {
    for (const msg of anthropicPayload.messages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue

      const content = msg.content
      const onlyToolResultAndText = content.every(
        (b) => b.type === "tool_result" || b.type === "text",
      )
      if (!onlyToolResultAndText) continue

      const toolResults = content.filter(
        (b): b is AnthropicToolResultBlock => b.type === "tool_result",
      )
      const textBlocks = content.filter(
        (b): b is AnthropicTextBlock => b.type === "text",
      )
      if (toolResults.length === textBlocks.length) {
        const mergedToolResults = mergeToolResult(toolResults, textBlocks)
        msg.content = mergedToolResults
      }
    }
  }
}

const mergeToolResult = (
  toolResults: Array<AnthropicToolResultBlock>,
  textBlocks: Array<AnthropicTextBlock>,
): Array<AnthropicToolResultBlock> => {
  const mergedToolResults: Array<AnthropicToolResultBlock> = []
  for (const [i, tr] of toolResults.entries()) {
    const tb = textBlocks[i]
    let skillText = tb.text
    if (tr.content.includes("skill")) {
      // need add please execute now, otherwise llm not execute skill directly only reply with text only
      skillText = `Please execute now:${tb.text}`
    }
    const mergedText = `${tr.content}\n\n${skillText}`
    mergedToolResults.push({ ...tr, content: mergedText })
  }
  return mergedToolResults
}
