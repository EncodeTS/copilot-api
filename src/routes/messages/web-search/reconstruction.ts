import { HTTPError } from "~/lib/error"
import {
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type TokenUsageRecordMetadata,
} from "~/lib/token-usage"
import { getUUID } from "~/lib/utils"
import type {
  ResponseOutputFunctionCall,
  ResponsesResult,
} from "~/services/copilot/create-responses"

import type {
  AnthropicContentBlockStartEvent,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  AnthropicWebSearchContentBlock,
  AnthropicWebSearchResultLocationCitation,
  AnthropicWebSearchResultItem,
} from "../anthropic-types"
import { parseFunctionCallArguments } from "../tool-arguments"
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
  type WebSearchHistoryContinuation,
  type WebSearchHistoryOutputItem,
} from "./history-carrier"
import {
  createWebSearchToolContract,
  type WebSearchToolContract,
} from "./tool-contract"

export type WebSearchCarrierMode =
  | "gateway-v1-exact-responses-scope"
  | "synthetic-without-encrypted-content"

export type WebSearchTurnPhase = "initial" | "resumed"

type WebSearchResponseBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicWebSearchContentBlock

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

const isStableToolId = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 512
  && value === value.trim()

const buildClientToolUseBlock = (
  call: ResponseOutputFunctionCall,
): AnthropicToolUseBlock => {
  const name = isStableToolId(call.namespace) ? call.namespace : call.name
  if (
    !isStableToolId(call.call_id)
    || !isStableToolId(name)
    || (call.status !== undefined && call.status !== "completed")
  ) {
    throw createWebSearchProtocolMismatchError(
      "Responses returned a malformed client tool call",
    )
  }
  return {
    type: "tool_use",
    id: call.call_id,
    name,
    input: parseFunctionCallArguments(call.arguments),
  }
}

const buildResponseContent = (
  requestId: string,
  output: ResponsesResult["output"],
  extract: WebSearchExtract,
  resumedPendingIds: ReadonlySet<string>,
  carrier?: string,
): Array<WebSearchResponseBlock> => {
  const blocks: Array<WebSearchResponseBlock> = []
  const hasCallSources = extract.calls.some(
    (call) => call.action.sources.length > 0,
  )
  let callIndex = 0
  let textBlockIndex = 0
  for (const item of output) {
    if (item.type === "function_call") {
      blocks.push(buildClientToolUseBlock(item))
      continue
    }
    if (item.type === "message") {
      for (const _content of item.content ?? []) {
        const textBlock = extract.textBlocks[textBlockIndex]
        if (!textBlock) {
          throw createWebSearchProtocolMismatchError(
            "Responses Web Search message projection is incomplete",
          )
        }
        blocks.push(buildTextBlock(textBlock))
        textBlockIndex += 1
      }
      continue
    }
    if (item.type !== "web_search_call") continue
    const call = extract.calls[callIndex]
    if (!call) {
      throw createWebSearchProtocolMismatchError(
        "Responses Web Search call projection is incomplete",
      )
    }
    const toolUseId = resolveCallId(call, requestId, callIndex)
    const sources =
      call.action.sources.length > 0 ? call.action.sources
      : !hasCallSources && callIndex === 0 ? extract.sources
      : []
    if (resumedPendingIds.has(toolUseId)) {
      if (call.status !== "completed" && call.status !== "failed") {
        throw createWebSearchProtocolMismatchError(
          "A resumed Web Search call did not produce its corresponding result",
        )
      }
      blocks.push(buildWebSearchResultBlock(toolUseId, sources, call.status))
      callIndex += 1
      continue
    }
    blocks.push({
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: {
        ...buildServerToolInput(call.action),
        ...(callIndex === 0 && carrier ?
          { [WEB_SEARCH_HISTORY_CARRIER_FIELD]: carrier }
        : {}),
      },
    })
    if (call.status === "completed" || call.status === "failed") {
      blocks.push(buildWebSearchResultBlock(toolUseId, sources, call.status))
    }
    callIndex += 1
  }
  if (extract.textBlocks.length === 0 && extract.answerText) {
    blocks.push({ type: "text", text: extract.answerText })
  }
  return blocks
}

const deriveWebSearchContinuation = (
  result: ResponsesResult,
  extract: WebSearchExtract,
): WebSearchHistoryContinuation => {
  const pendingServerToolUseIds = extract.calls.flatMap((call) => {
    if (call.status !== "in_progress" && call.status !== "searching") return []
    if (!isStableToolId(call.id)) {
      throw createWebSearchProtocolMismatchError(
        "Responses returned an unfinished Web Search call without a stable ID",
      )
    }
    return [call.id]
  })
  if (pendingServerToolUseIds.length === 0) return { kind: "complete" }

  const pendingClientToolUseIds = result.output.flatMap((item) =>
    item.type === "function_call" ? [buildClientToolUseBlock(item).id] : [],
  )
  if (
    new Set(pendingClientToolUseIds).size !== pendingClientToolUseIds.length
  ) {
    throw createWebSearchProtocolMismatchError(
      "Responses returned duplicate client tool call IDs",
    )
  }
  if (pendingClientToolUseIds.length > 0) {
    return {
      kind: "waiting_client_tools",
      pending_server_tool_use_ids: pendingServerToolUseIds,
      pending_client_tool_use_ids: pendingClientToolUseIds,
    }
  }
  return {
    kind: "pause_turn",
    pending_server_tool_use_ids: pendingServerToolUseIds,
  }
}

export const projectWebSearchSyntheticHistory = (
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
  carrier: string,
): Array<WebSearchResponseBlock> => {
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
  return buildResponseContent(
    "carrier-projection",
    output,
    extract,
    new Set(),
    carrier,
  )
}

const createHistoryCarrier = (
  result: ResponsesResult,
  source: WebSearchHistoryCarrierSource | undefined,
  extract: WebSearchExtract,
  continuation: WebSearchHistoryContinuation,
  toolContract: WebSearchToolContract | undefined,
  turnPhase: WebSearchTurnPhase,
): { carrier?: string; mode: WebSearchCarrierMode } => {
  if (turnPhase === "resumed") {
    if (continuation.kind !== "complete") {
      throw createWebSearchProtocolMismatchError(
        "A resumed Web Search turn cannot leave another pending server call",
      )
    }
    return { mode: "synthetic-without-encrypted-content" }
  }
  if (!source && continuation.kind !== "complete") {
    throw createWebSearchProtocolMismatchError(
      "Responses ended with an unfinished Web Search call without a resumable carrier scope",
    )
  }
  const hasTopLevelOnlyText =
    extract.textBlocks.length === 0 && extract.answerText.length > 0
  if (hasTopLevelOnlyText && continuation.kind !== "complete") {
    throw createWebSearchProtocolMismatchError(
      "Responses returned pending Web Search state with non-resumable top-level text",
    )
  }
  if (!source || hasTopLevelOnlyText) {
    return { mode: "synthetic-without-encrypted-content" }
  }
  try {
    return {
      carrier: encodeWebSearchHistoryCarrier({
        source,
        output_items: result.output,
        continuation,
        ...(toolContract && { tool_contract: toolContract }),
      }),
      mode: "gateway-v1-exact-responses-scope",
    }
  } catch (error) {
    if (error instanceof WebSearchHistoryCarrierValidationError) {
      if (continuation.kind !== "complete") {
        throw createWebSearchProtocolMismatchError(
          "Responses returned non-resumable pending Web Search state",
        )
      }
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

const resolveResumedPendingIds = (
  extract: WebSearchExtract,
  options: {
    resumedPendingServerToolUseIds?: ReadonlyArray<string>
    turnPhase?: WebSearchTurnPhase
  },
): { ids: ReadonlySet<string>; turnPhase: WebSearchTurnPhase } => {
  const values = options.resumedPendingServerToolUseIds ?? []
  const turnPhase =
    options.turnPhase ?? (values.length > 0 ? "resumed" : "initial")
  if (
    (turnPhase === "initial" && values.length > 0)
    || (turnPhase === "resumed" && values.length === 0)
    || values.some((id) => !isStableToolId(id))
    || new Set(values).size !== values.length
  ) {
    throw createWebSearchProtocolMismatchError(
      "Responses Web Search resume metadata is malformed",
    )
  }
  const ids = new Set(values)
  if (ids.size > 0) {
    const matched = extract.calls.filter(
      (call) =>
        typeof call.id === "string"
        && ids.has(call.id)
        && (call.status === "completed" || call.status === "failed"),
    )
    if (matched.length !== ids.size) {
      throw createWebSearchProtocolMismatchError(
        "A resumed Web Search call did not produce its corresponding result",
      )
    }
  }
  return { ids, turnPhase }
}

export const reconstructWebSearchResponse = (
  payload: AnthropicMessagesPayload,
  result: ResponsesResult,
  options: {
    carrierSource?: WebSearchHistoryCarrierSource
    requestId: string
    resumedPendingServerToolUseIds?: ReadonlyArray<string>
    turnPhase?: WebSearchTurnPhase
  },
): {
  carrierMode: WebSearchCarrierMode
  extract: WebSearchExtract
  response: AnthropicResponse<WebSearchResponseBlock>
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
  const resumed = resolveResumedPendingIds(extract, options)
  const hasPendingServerCall = extract.calls.some(
    (call) => call.status === "in_progress" || call.status === "searching",
  )
  if (result.status === "incomplete" && hasPendingServerCall) {
    throw createWebSearchProtocolMismatchError(
      "An unfinished Web Search call cannot override an incomplete Responses terminal",
    )
  }
  const continuation =
    result.status === "completed" ?
      deriveWebSearchContinuation(result, extract)
    : { kind: "complete" as const }
  const stopReason =
    continuation.kind === "waiting_client_tools" ? "tool_use"
    : continuation.kind === "pause_turn" ? "pause_turn"
    : mapResponsesStopReasonToAnthropic(result)
  if (stopReason === null) {
    throw createWebSearchProtocolMismatchError()
  }
  const historyCarrier = createHistoryCarrier(
    result,
    options.carrierSource,
    extract,
    continuation,
    continuation.kind === "complete" ?
      undefined
    : createWebSearchToolContract(payload.tools),
    resumed.turnPhase,
  )
  const usage = mapResponsesUsageToAnthropic(result.usage)
  const response: AnthropicResponse<WebSearchResponseBlock> = {
    id: result.id || getUUID(options.requestId),
    type: "message",
    role: "assistant",
    content: buildResponseContent(
      options.requestId,
      result.output,
      extract,
      resumed.ids,
      historyCarrier.carrier,
    ),
    model: payload.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      ...usage,
      server_tool_use: {
        web_search_requests: extract.calls.filter(
          (call) => !call.id || !resumed.ids.has(call.id),
        ).length,
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
  block: WebSearchResponseBlock,
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
    case "tool_use": {
      return [
        start({
          type: "tool_use",
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
  response: AnthropicResponse<WebSearchResponseBlock>,
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
