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
  AnthropicWebSearchResultLocationCitation,
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
import {
  extractWebSearchResult,
  WebSearchSemanticValidationError,
  type WebSearchAction,
  type WebSearchCall,
  type WebSearchExtract,
  type WebSearchSource,
  type WebSearchTextBlock,
} from "./backend"
import {
  encodeWebSearchHistoryCarrier,
  WebSearchHistoryCarrierValidationError,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
  type WebSearchHistoryCarrierSource,
  type WebSearchHistoryOutputItem,
} from "./history-carrier"

export type WebSearchCarrierMode =
  | "gateway-v1-exact-responses-scope"
  | "synthetic-without-encrypted-content"

const buildWebSearchResultBlock = (
  toolUseId: string,
  sources: Array<WebSearchSource>,
  status: string | undefined,
): AnthropicWebSearchContentBlock => {
  if (status === "failed") {
    return {
      type: "web_search_tool_result",
      tool_use_id: toolUseId,
      content: {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
    }
  }
  const items: Array<AnthropicWebSearchResultItem> = sources.map((source) => ({
    type: "web_search_result",
    url: source.url,
    title: source.title,
    page_age: source.page_age ?? null,
  }))
  return {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: items,
  }
}

const buildServerToolInput = (
  action: WebSearchAction,
): Record<string, unknown> => ({
  ...(action.type !== undefined && { type: action.type }),
  ...(action.query !== undefined && { query: action.query }),
  ...(action.queries !== undefined && { queries: [...action.queries] }),
  ...(action.url !== undefined && { url: action.url }),
  ...(action.pattern !== undefined && { pattern: action.pattern }),
})

const buildTextBlock = (block: WebSearchTextBlock): AnthropicTextBlock => {
  const citations: Array<AnthropicWebSearchResultLocationCitation> =
    block.citations.flatMap((citation) =>
      citation.citedText === undefined ?
        []
      : [
          {
            type: "web_search_result_location" as const,
            url: citation.url,
            title: citation.title,
            cited_text: citation.citedText,
          },
        ],
    )
  return {
    type: "text",
    text: block.text,
    ...(citations.length > 0 && { citations }),
  }
}

const resolveCallId = (
  call: WebSearchCall,
  requestId: string,
  index: number,
): string => call.id?.trim() || `srvtoolu_${getUUID(`${requestId}:${index}`)}`

const buildResponseContent = (
  requestId: string,
  extract: WebSearchExtract,
  carrier?: string,
): Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> => {
  const blocks: Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> = []
  const hasCallSources = extract.calls.some(
    (call) => call.action.sources.length > 0,
  )
  extract.calls.forEach((call, index) => {
    const toolUseId = resolveCallId(call, requestId, index)
    const sources =
      call.action.sources.length > 0 ? call.action.sources
      : !hasCallSources && index === 0 ? extract.sources
      : []
    blocks.push(
      {
        type: "server_tool_use",
        id: toolUseId,
        name: "web_search",
        input: {
          ...buildServerToolInput(call.action),
          ...(index === 0 && carrier ?
            { [WEB_SEARCH_HISTORY_CARRIER_FIELD]: carrier }
          : {}),
        },
      },
      buildWebSearchResultBlock(toolUseId, sources, call.status),
    )
  })
  if (extract.textBlocks.length > 0) {
    blocks.push(...extract.textBlocks.map(buildTextBlock))
  } else if (extract.answerText) {
    blocks.push({ type: "text", text: extract.answerText })
  }
  return blocks
}

export const projectWebSearchSyntheticHistory = (
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
  carrier: string,
): Array<AnthropicTextBlock | AnthropicWebSearchContentBlock> => {
  const output = structuredClone(
    outputItems,
  ) as unknown as ResponsesResult["output"]
  const status =
    (
      output.some(
        (item) => item.type === "message" && item.status === "incomplete",
      )
    ) ?
      "incomplete"
    : "completed"
  const extract = extractWebSearchResult({
    output,
    output_text: "",
    status,
  } as ResponsesResult)
  return buildResponseContent("carrier-projection", extract, carrier)
}

const createHistoryCarrier = (
  result: ResponsesResult,
  source: WebSearchHistoryCarrierSource | undefined,
  extract: WebSearchExtract,
): { carrier?: string; mode: WebSearchCarrierMode } => {
  if (
    !source
    || (extract.textBlocks.length === 0 && extract.answerText.length > 0)
  ) {
    return { mode: "synthetic-without-encrypted-content" }
  }
  try {
    return {
      carrier: encodeWebSearchHistoryCarrier({
        source,
        output_items: result.output,
        continuation: { kind: "complete" },
      }),
      mode: "gateway-v1-exact-responses-scope",
    }
  } catch (error) {
    if (error instanceof WebSearchHistoryCarrierValidationError) {
      return { mode: "synthetic-without-encrypted-content" }
    }
    throw error
  }
}

const createWebSearchProtocolMismatchError = (
  message = "Responses incomplete result has no Anthropic stop-reason equivalent",
): HTTPError => {
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
  options: {
    carrierSource?: WebSearchHistoryCarrierSource
    requestId: string
  },
): {
  carrierMode: WebSearchCarrierMode
  extract: WebSearchExtract
  response: AnthropicResponse<
    AnthropicTextBlock | AnthropicWebSearchContentBlock
  >
} => {
  assertResponsesResultUsable(result)
  let extract: WebSearchExtract
  try {
    extract = extractWebSearchResult(result)
  } catch (error) {
    if (error instanceof WebSearchSemanticValidationError) {
      throw createWebSearchProtocolMismatchError(
        "Responses returned malformed Web Search output",
      )
    }
    throw error
  }
  const stopReason = mapResponsesStopReasonToAnthropic(result)
  if (stopReason === null) {
    throw createWebSearchProtocolMismatchError()
  }
  if (
    extract.calls.some(
      (call) => call.status === "in_progress" || call.status === "searching",
    )
  ) {
    throw createWebSearchProtocolMismatchError(
      "Responses ended with an unfinished Web Search call",
    )
  }
  const historyCarrier = createHistoryCarrier(
    result,
    options.carrierSource,
    extract,
  )
  const usage = mapResponsesUsageToAnthropic(result.usage)
  const response: AnthropicResponse<
    AnthropicTextBlock | AnthropicWebSearchContentBlock
  > = {
    id: result.id || getUUID(options.requestId),
    type: "message",
    role: "assistant",
    content: buildResponseContent(
      options.requestId,
      extract,
      historyCarrier.carrier,
    ),
    model: payload.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      ...usage,
      server_tool_use: {
        web_search_requests: extract.callCount,
      },
    },
    ...(result.copilot_usage !== undefined && {
      copilot_usage: result.copilot_usage,
    }),
  }

  return { carrierMode: historyCarrier.mode, extract, response }
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
        ...(block.citations ?? []).map(
          (citation): AnthropicStreamEventData => ({
            type: "content_block_delta",
            index,
            delta: { type: "citations_delta", citation },
          }),
        ),
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
      ...(response.copilot_usage !== undefined && {
        copilot_usage: response.copilot_usage,
      }),
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
