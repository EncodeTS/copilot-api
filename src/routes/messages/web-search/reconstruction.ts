import { HTTPError } from "~/lib/error"
import {
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type TokenUsageRecordMetadata,
} from "~/lib/token-usage"
import { getUUID } from "~/lib/utils"
import type { ResponsesResult } from "~/services/copilot/create-responses"

import type {
  AnthropicContentBlockStartEvent,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTextBlock,
  AnthropicWebSearchContentBlock,
  AnthropicWebSearchResultItem,
} from "../anthropic-types"
import {
  assertResponsesResultUsable,
  getResponsesResultFailureMessage,
} from "../responses-result"
import {
  mapResponsesStopReasonToAnthropic,
  mapResponsesUsageToAnthropic,
} from "../responses-translation"
import { extractWebSearchResult, type WebSearchExtract } from "./backend"

const buildWebSearchResultBlock = (
  toolUseId: string,
  extract: WebSearchExtract,
): AnthropicWebSearchContentBlock => {
  const items: Array<AnthropicWebSearchResultItem> = extract.sources.map(
    (source) => ({
      type: "web_search_result",
      url: source.url,
      title: source.title,
      page_age: source.page_age ?? null,
    }),
  )
  return {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: items,
  }
}

const buildResponseContent = (
  requestId: string,
  extract: WebSearchExtract,
): Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> => {
  const blocks: Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> = []
  const query = extract.queries[0] ?? ""
  if (extract.callCount > 0) {
    const toolUseId = `srvtoolu_${getUUID(requestId)}`
    blocks.push(
      {
        type: "server_tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query },
      },
      buildWebSearchResultBlock(toolUseId, extract),
    )
  }
  blocks.push({ type: "text", text: extract.answerText })
  return blocks
}

const createWebSearchProtocolMismatchError = (): HTTPError => {
  const message =
    "Responses incomplete result has no Anthropic stop-reason equivalent"
  return new HTTPError(
    message,
    new Response(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message },
      }),
      {
        status: 502,
        headers: { "content-type": "application/json" },
      },
    ),
  )
}

export const reconstructWebSearchResponse = (
  payload: AnthropicMessagesPayload,
  result: ResponsesResult,
  options: { requestId: string },
): {
  extract: WebSearchExtract
  response: AnthropicResponse<
    AnthropicTextBlock | AnthropicWebSearchContentBlock
  >
} => {
  assertResponsesResultUsable(result)
  const extract = extractWebSearchResult(result)
  const stopReason = mapResponsesStopReasonToAnthropic(result)
  if (stopReason === null) {
    throw createWebSearchProtocolMismatchError()
  }
  const usage = mapResponsesUsageToAnthropic(result.usage)
  const response: AnthropicResponse<
    AnthropicTextBlock | AnthropicWebSearchContentBlock
  > = {
    id: result.id || getUUID(options.requestId),
    type: "message",
    role: "assistant",
    content: buildResponseContent(options.requestId, extract),
    model: payload.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      ...usage,
      server_tool_use: {
        web_search_requests: extract.callCount,
      },
    },
  }

  return { extract, response }
}

export const normalizeWebSearchResponsesUsage = (result: ResponsesResult) => {
  const totalNanoAiu = normalizeOptionalToken(
    result.copilot_usage?.total_nano_aiu,
  )
  return {
    ...normalizeResponsesUsage(result.usage),
    ...(totalNanoAiu !== undefined && { total_nano_aiu: totalNanoAiu }),
  }
}

export const getWebSearchUsageMetadata = (
  result: ResponsesResult,
  disposition: "mapped" | "rejected",
): TokenUsageRecordMetadata | undefined => {
  if (disposition === "rejected") {
    const upstreamFailure = getResponsesResultFailureMessage(result)
    return upstreamFailure ?
        {
          errorCode: "response_failed",
          outcome: "failed",
          terminal:
            result.status === "failed" || result.error ?
              "response.failed"
            : "unknown_terminal",
        }
      : {
          errorCode: "invalid_response",
          outcome: "failed",
          terminal:
            result.status === "incomplete" ?
              "response.incomplete"
            : "unknown_terminal",
        }
  }
  if (result.status === "incomplete") {
    const reason = (result.incomplete_details as { reason?: string } | null)
      ?.reason
    return {
      ...(reason === "max_output_tokens" || reason === "max_tokens" ?
        { errorCode: "max_output_tokens" as const }
      : {}),
      outcome: "incomplete",
      terminal: "response.incomplete",
    }
  }
}

const blockToStreamEvents = (
  block: AnthropicTextBlock | AnthropicWebSearchContentBlock,
  index: number,
): Array<AnthropicStreamEventData> => {
  const start = (
    contentBlock: AnthropicContentBlockStartEvent["content_block"],
  ): AnthropicContentBlockStartEvent => ({
    type: "content_block_start",
    index,
    content_block: contentBlock,
  })
  const stop: AnthropicStreamEventData = {
    type: "content_block_stop",
    index,
  }

  switch (block.type) {
    case "text": {
      return [
        start({ type: "text", text: "" }),
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
        stop,
      ]
    }
    case "server_tool_use": {
      return [
        start({
          type: "server_tool_use",
          id: block.id,
          name: block.name,
          input: {},
        }),
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
        stop,
      ]
    }
    case "web_search_tool_result": {
      return [start(block), stop]
    }
    default: {
      return [start(block), stop]
    }
  }
}

export const buildSyntheticStreamEvents = (
  response: AnthropicResponse<
    AnthropicTextBlock | AnthropicWebSearchContentBlock
  >,
): Array<AnthropicStreamEventData> => {
  const events: Array<AnthropicStreamEventData> = []

  events.push({
    type: "message_start",
    message: {
      id: response.id,
      type: "message",
      role: "assistant",
      content: [],
      model: response.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { ...response.usage, output_tokens: 0 },
    },
  })

  response.content.forEach((block, index) => {
    events.push(...blockToStreamEvents(block, index))
  })

  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: response.stop_reason,
        stop_sequence: response.stop_sequence,
      },
      usage: { output_tokens: response.usage.output_tokens },
    },
    { type: "message_stop" },
  )

  return events
}
