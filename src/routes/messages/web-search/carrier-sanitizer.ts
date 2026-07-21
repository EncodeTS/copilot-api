import { createMessagesInvalidRequestError } from "~/routes/messages/invalid-request-error"
import type { ProviderType } from "~/lib/config"
import { isDeepStrictEqual } from "node:util"
import type {
  AnthropicAssistantMessage,
  AnthropicMessagesPayload,
} from "~/routes/messages/anthropic-types"

import {
  decodeWebSearchHistoryCarrier,
  WEB_SEARCH_HISTORY_CARRIER_FIELD,
  type WebSearchHistoryCarrierEnvelopeV1,
  type WebSearchHistoryContinuation,
  type WebSearchHistoryOutputItem,
} from "./history-carrier"
import { projectWebSearchSyntheticHistory } from "./reconstruction"
import {
  createWebSearchToolContract,
  type WebSearchToolContract,
} from "./tool-contract"

export type WebSearchCarrierSanitizerContext =
  | {
      destination: "responses"
      canonicalTarget: {
        adapter: "copilot-responses" | "provider-responses"
        provider: string
        model: string
      }
    }
  | {
      destination: "messages"
      canonicalTarget: {
        adapter: "anthropic-messages"
        provider: string
        model: string
      }
    }
  | {
      destination: "chat_completions"
      canonicalTarget: {
        adapter: "chat-completions"
        provider: string
        model: string
      }
    }

export interface RestoredWebSearchTurn {
  readonly continuation: WebSearchHistoryContinuation
  readonly messageIndex: number
  readonly outputItems: ReadonlyArray<WebSearchHistoryOutputItem>
}

export interface WebSearchCarrierSanitization {
  readonly restoredTurns: ReadonlyArray<RestoredWebSearchTurn>
  readonly resumedPendingServerToolUseIds: ReadonlyArray<string>
  readonly turnPhase: "initial" | "resumed"
}

export interface WebSearchCarrierSanitizer {
  sanitize: (
    payload: AnthropicMessagesPayload,
    context: WebSearchCarrierSanitizerContext,
  ) => WebSearchCarrierSanitization
}

export const createProviderWebSearchCarrierContext = (
  providerType: ProviderType,
  provider: string,
  model: string,
): WebSearchCarrierSanitizerContext => {
  const canonicalModel = model.trim()
  if (providerType === "openai-responses") {
    return {
      destination: "responses",
      canonicalTarget: {
        adapter: "provider-responses",
        provider,
        model: canonicalModel,
      },
    }
  }
  if (providerType === "anthropic") {
    return {
      destination: "messages",
      canonicalTarget: {
        adapter: "anthropic-messages",
        provider,
        model: canonicalModel,
      },
    }
  }
  return {
    destination: "chat_completions",
    canonicalTarget: {
      adapter: "chat-completions",
      provider,
      model: canonicalModel,
    },
  }
}

const EMPTY_SANITIZATION = Object.freeze<WebSearchCarrierSanitization>({
  restoredTurns: Object.freeze([]),
  resumedPendingServerToolUseIds: Object.freeze([]),
  turnPhase: "initial",
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface LocatedCarrier {
  carrier: unknown
  contentIndex: number
  message: AnthropicAssistantMessage
  messageIndex: number
}

const locateCarriers = (
  payload: AnthropicMessagesPayload,
): Array<LocatedCarrier> => {
  const located: Array<LocatedCarrier> = []
  payload.messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return
    message.content.forEach((block, contentIndex) => {
      if (!isRecord(block) || !isRecord(block.input)) return
      if (!Object.hasOwn(block.input, WEB_SEARCH_HISTORY_CARRIER_FIELD)) return
      if (
        message.role !== "assistant"
        || block.type !== "server_tool_use"
        || block.name !== "web_search"
      ) {
        throwCarrierError("malformed-placement")
      }
      const assistantMessage = message as AnthropicAssistantMessage
      located.push({
        carrier: block.input[WEB_SEARCH_HISTORY_CARRIER_FIELD],
        contentIndex,
        message: assistantMessage,
        messageIndex,
      })
    })
  })
  return located
}

const assertFirstSearchUse = (located: LocatedCarrier): void => {
  const { content } = located.message
  if (!Array.isArray(content)) {
    throwCarrierError("malformed-placement")
  }
  const contentBlocks = content as Array<unknown>
  const firstSearchUseIndex = contentBlocks.findIndex(
    (block) =>
      isRecord(block)
      && block.type === "server_tool_use"
      && block.name === "web_search",
  )
  if (firstSearchUseIndex !== located.contentIndex) {
    throwCarrierError("malformed-placement")
  }
}

const hasNativeOpaqueHistory = (message: AnthropicAssistantMessage): boolean =>
  Array.isArray(message.content)
  && message.content.some((block) => {
    if (!isRecord(block)) return false
    if (
      block.type === "server_tool_use"
      && block.name === "web_search"
      && Object.hasOwn(block, "caller")
    ) {
      return true
    }
    if (
      block.type === "web_search_tool_result"
      && Array.isArray(block.content)
      && block.content.some(
        (item) =>
          isRecord(item)
          && typeof item.encrypted_content === "string"
          && item.encrypted_content.length > 0,
      )
    ) {
      return true
    }
    return (
      block.type === "text"
      && Array.isArray(block.citations)
      && block.citations.some(
        (citation) =>
          isRecord(citation)
          && typeof citation.encrypted_index === "string"
          && citation.encrypted_index.length > 0,
      )
    )
  })

const hasWebSearchHistoryBlocks = (
  message: AnthropicMessagesPayload["messages"][number],
): boolean =>
  Array.isArray(message.content)
  && message.content.some(
    (block) =>
      isRecord(block)
      && ((block.type === "server_tool_use" && block.name === "web_search")
        || block.type === "web_search_tool_result"),
  )

const hasMarkerlessErrorResult = (
  message: AnthropicAssistantMessage,
): boolean =>
  Array.isArray(message.content)
  && message.content.some(
    (block) =>
      isRecord(block)
      && block.type === "web_search_tool_result"
      && isRecord(block.content)
      && block.content.type === "web_search_tool_result_error",
  )

const assertCompleteMarkerlessHistory = (
  message: AnthropicAssistantMessage,
): void => {
  if (!Array.isArray(message.content)) return
  const pendingUses = new Set<string>()
  const completedUses = new Set<string>()
  for (const block of message.content) {
    if (!isRecord(block)) continue
    if (block.type === "server_tool_use" && block.name === "web_search") {
      if (
        typeof block.id !== "string"
        || !block.id.trim()
        || pendingUses.has(block.id)
        || completedUses.has(block.id)
      ) {
        throwCarrierError("markerless Web Search call IDs are invalid")
      }
      pendingUses.add(block.id)
      continue
    }
    if (block.type !== "web_search_tool_result") continue
    const toolUseId = block.tool_use_id
    if (
      typeof toolUseId !== "string"
      || !pendingUses.delete(toolUseId)
      || completedUses.has(toolUseId)
    ) {
      throwCarrierError("markerless Web Search results are unmatched")
    }
    completedUses.add(toolUseId)
  }
  if (pendingUses.size > 0) {
    throwCarrierError("markerless Web Search calls are incomplete")
  }
}

const isStableContinuationId = (value: unknown): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= 512
  && value === value.trim()

const getPendingClientCalls = (
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
): Array<{ id: string; name: string }> =>
  outputItems.flatMap((item) => {
    if (item.type !== "function_call") return []
    const name =
      isStableContinuationId(item.namespace) ? item.namespace : item.name
    return (
        isStableContinuationId(item.call_id) && isStableContinuationId(name)
      ) ?
        [{ id: item.call_id, name }]
      : []
  })

const assertContinuationMatchesOutput = (
  continuation: WebSearchHistoryContinuation,
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
): void => {
  const pendingServerIds = outputItems.flatMap((item) =>
    (
      item.type === "web_search_call"
      && (item.status === "in_progress" || item.status === "searching")
      && isStableContinuationId(item.id)
    ) ?
      [item.id]
    : [],
  )
  if (continuation.kind === "complete") {
    if (pendingServerIds.length > 0) {
      throwCarrierError("completed carrier contains a pending server tool")
    }
    return
  }
  if (
    !isDeepStrictEqual(
      continuation.pending_server_tool_use_ids,
      pendingServerIds,
    )
  ) {
    throwCarrierError("pending server tools do not match the carrier output")
  }

  if (continuation.kind === "pause_turn") return

  const pendingClientCalls = getPendingClientCalls(outputItems)
  if (
    !isDeepStrictEqual(
      continuation.pending_client_tool_use_ids,
      pendingClientCalls.map((call) => call.id),
    )
  ) {
    throwCarrierError("pending client tools do not match the carrier output")
  }
}

const assertPendingToolDefinitions = (
  continuation: Exclude<WebSearchHistoryContinuation, { kind: "complete" }>,
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
  payload: AnthropicMessagesPayload,
  expectedContract: WebSearchToolContract | undefined,
): void => {
  let currentContract: WebSearchToolContract | null = null
  try {
    currentContract = createWebSearchToolContract(payload.tools)
  } catch {
    throwCarrierError("pending tool contract is malformed")
  }
  if (
    !currentContract
    || !expectedContract
    || !isDeepStrictEqual(currentContract, expectedContract)
  ) {
    throwCarrierError("pending tool contract changed")
  }
  const hasWebSearchTool = payload.tools?.some(
    (tool) =>
      tool.name === "web_search"
      && typeof tool.type === "string"
      && tool.type.startsWith("web_search"),
  )
  if (!hasWebSearchTool) {
    throwCarrierError("pending server tool definition was not retained")
  }
  if (continuation.kind === "pause_turn") return

  const pendingClientCalls = getPendingClientCalls(outputItems)
  for (const call of pendingClientCalls) {
    const definitions =
      payload.tools?.filter(
        (tool) => tool.name === call.name && tool.input_schema !== undefined,
      ) ?? []
    if (definitions.length !== 1) {
      throwCarrierError("pending client tool definition was not retained")
    }
  }
}

interface ResumedServerResult {
  readonly id: string
  readonly sources: ReadonlyArray<Record<string, unknown>>
  readonly status: "completed" | "failed"
}

const readPendingServerCompletion = (
  message: AnthropicMessagesPayload["messages"][number] | undefined,
  pendingServerIds: ReadonlyArray<string>,
): ReadonlyArray<ResumedServerResult> => {
  const content =
    message?.role === "assistant" && Array.isArray(message.content) ?
      message.content
    : null
  if (!content) {
    throwCarrierError("pending server tools must complete before later input")
  }
  const results = new Array<ResumedServerResult>()
  for (const block of content as Array<unknown>) {
    if (
      !isRecord(block)
      || block.type !== "web_search_tool_result"
      || !isStableContinuationId(block.tool_use_id)
    ) {
      continue
    }
    if (
      isRecord(block.content)
      && block.content.type === "web_search_tool_result_error"
    ) {
      results.push({
        id: block.tool_use_id,
        sources: Object.freeze([]),
        status: "failed",
      })
      continue
    }
    const resultContent = block.content
    if (!Array.isArray(resultContent)) {
      throwCarrierError("pending server tool result is malformed")
    }
    const resultItems =
      Array.isArray(resultContent) ? (resultContent as Array<unknown>) : []
    const sources = resultItems.map((item: unknown) => {
      const source = isRecord(item) ? item : null
      if (
        !source
        || source.type !== "web_search_result"
        || typeof source.url !== "string"
        || !source.url
        || typeof source.title !== "string"
        || !source.title
      ) {
        throwCarrierError("pending server tool result is malformed")
      }
      const validSource = source as Record<string, unknown>
      return Object.freeze({
        type: "url",
        url: validSource.url,
        title: validSource.title,
        ...((
          validSource.page_age === null
          || typeof validSource.page_age === "string"
        ) ?
          { page_age: validSource.page_age }
        : {}),
      })
    })
    results.push({
      id: block.tool_use_id,
      sources: Object.freeze(sources),
      status: "completed",
    })
  }
  if (
    !isDeepStrictEqual(
      results.map((result) => result.id),
      pendingServerIds,
    )
  ) {
    throwCarrierError("pending server tools were not completed in order")
  }
  return Object.freeze(results)
}

const assertPendingServerCompletion = (
  message: AnthropicMessagesPayload["messages"][number] | undefined,
  pendingServerIds: ReadonlyArray<string>,
): void => {
  readPendingServerCompletion(message, pendingServerIds)
}

const resolvePendingOutputItems = (
  outputItems: ReadonlyArray<WebSearchHistoryOutputItem>,
  pendingServerIds: ReadonlyArray<string>,
  completionMessage: AnthropicMessagesPayload["messages"][number] | undefined,
): ReadonlyArray<WebSearchHistoryOutputItem> => {
  const results = new Map(
    readPendingServerCompletion(completionMessage, pendingServerIds).map(
      (result) => [result.id, result] as const,
    ),
  )
  return Object.freeze(
    outputItems.map((item) => {
      const result =
        item.type === "web_search_call" && typeof item.id === "string" ?
          results.get(item.id)
        : undefined
      if (!result) return item
      const action = isRecord(item.action) ? structuredClone(item.action) : {}
      return Object.freeze({
        ...structuredClone(item),
        status: result.status,
        action: {
          ...action,
          sources: result.sources.map((source) => ({ ...source })),
        },
      })
    }),
  )
}

const assertContinuationFollowUp = (
  continuation: WebSearchHistoryContinuation,
  messageIndex: number,
  payload: AnthropicMessagesPayload,
): boolean => {
  if (continuation.kind === "complete") return false
  if (continuation.kind === "pause_turn") {
    if (messageIndex === payload.messages.length - 1) return true
    assertPendingServerCompletion(
      payload.messages[messageIndex + 1],
      continuation.pending_server_tool_use_ids,
    )
    return false
  }

  const followUpIndex = messageIndex + 1
  const followUp = payload.messages[followUpIndex]
  if (followUp?.role !== "user" || !Array.isArray(followUp.content)) {
    throwCarrierError(
      "waiting client tools require one immediate result message",
    )
  }
  const resultIds = (followUp.content as Array<unknown>).map((block) => {
    const toolUseId = isRecord(block) ? block.tool_use_id : undefined
    if (
      !isRecord(block)
      || block.type !== "tool_result"
      || !isStableContinuationId(toolUseId)
    ) {
      throwCarrierError(
        "client continuation must contain only tool_result blocks",
      )
    }
    return toolUseId
  })
  if (!isDeepStrictEqual(resultIds, continuation.pending_client_tool_use_ids)) {
    throwCarrierError(
      "client tool results are missing, duplicate, or out of order",
    )
  }
  if (followUpIndex === payload.messages.length - 1) return true
  assertPendingServerCompletion(
    payload.messages[followUpIndex + 1],
    continuation.pending_server_tool_use_ids,
  )
  return false
}

const throwCarrierError = (reason: string): never => {
  throw createMessagesInvalidRequestError(
    `Web Search history carrier rejected: ${reason}`,
  )
}

interface ValidatedCarrierState {
  readonly carrier: LocatedCarrier
  readonly completionMessageIndex: number | null
  readonly envelope: WebSearchHistoryCarrierEnvelopeV1
  readonly remainsPending: boolean
  readonly restoredOutputItems: ReadonlyArray<WebSearchHistoryOutputItem>
}

const getCompletionMessageIndex = (
  continuation: WebSearchHistoryContinuation,
  messageIndex: number,
): number | null =>
  continuation.kind === "pause_turn" ? messageIndex + 1
  : continuation.kind === "waiting_client_tools" ? messageIndex + 2
  : null

const sanitizeWebSearchCarrier = (
  payload: AnthropicMessagesPayload,
  context: WebSearchCarrierSanitizerContext,
): WebSearchCarrierSanitization => {
  const located = locateCarriers(payload)
  const carriersByMessageIndex = new Map<number, Array<LocatedCarrier>>()
  for (const carrier of located) {
    const carriers = carriersByMessageIndex.get(carrier.messageIndex) ?? []
    carriers.push(carrier)
    carriersByMessageIndex.set(carrier.messageIndex, carriers)
  }

  const seenMessageIndexes = new Set<number>()
  const validatedStates = new Array<ValidatedCarrierState>()
  for (const carrier of located) {
    if (seenMessageIndexes.has(carrier.messageIndex)) {
      throwCarrierError("duplicate-marker")
    }
    seenMessageIndexes.add(carrier.messageIndex)
    assertFirstSearchUse(carrier)
    const decoded = decodeWebSearchHistoryCarrier(carrier.carrier, context)
    if (decoded.kind === "legacy") throwCarrierError("missing-marker")
    if (decoded.kind === "rejected") throwCarrierError(decoded.reason)
    const accepted = decoded as Extract<typeof decoded, { kind: "accepted" }>
    assertContinuationMatchesOutput(
      accepted.envelope.continuation,
      accepted.envelope.output_items,
    )
    const remainsPending = assertContinuationFollowUp(
      accepted.envelope.continuation,
      carrier.messageIndex,
      payload,
    )
    if (remainsPending && accepted.envelope.continuation.kind !== "complete") {
      assertPendingToolDefinitions(
        accepted.envelope.continuation,
        accepted.envelope.output_items,
        payload,
        accepted.envelope.tool_contract,
      )
    }
    let expectedContent: ReturnType<typeof projectWebSearchSyntheticHistory> =
      []
    try {
      expectedContent = projectWebSearchSyntheticHistory(
        accepted.envelope.output_items,
        carrier.carrier as string,
      )
    } catch {
      throwCarrierError("carrier Web Search output is malformed")
    }
    if (!isDeepStrictEqual(carrier.message.content, expectedContent)) {
      throwCarrierError("carrier turn does not match its synthetic projection")
    }
    const completionMessageIndex =
      remainsPending ? null : (
        getCompletionMessageIndex(
          accepted.envelope.continuation,
          carrier.messageIndex,
        )
      )
    const restoredOutputItems =
      completionMessageIndex === null ?
        accepted.envelope.output_items
      : resolvePendingOutputItems(
          accepted.envelope.output_items,
          accepted.envelope.continuation.kind === "complete" ?
            []
          : accepted.envelope.continuation.pending_server_tool_use_ids,
          payload.messages[completionMessageIndex],
        )
    validatedStates.push(
      Object.freeze({
        carrier,
        completionMessageIndex,
        envelope: accepted.envelope,
        remainsPending,
        restoredOutputItems,
      }),
    )
  }
  const resumedResultMessageIndexes = new Set(
    validatedStates.flatMap((state) =>
      state.completionMessageIndex === null ?
        []
      : [state.completionMessageIndex],
    ),
  )

  for (const [messageIndex, message] of payload.messages.entries()) {
    const hasSearchHistory = hasWebSearchHistoryBlocks(message)
    if (message.role !== "assistant") {
      if (!hasSearchHistory) continue
      throwCarrierError("Web Search history must belong to an assistant turn")
    }
    const assistantMessage = message as AnthropicAssistantMessage
    const nativeOpaqueHistory = hasNativeOpaqueHistory(assistantMessage)
    if (!hasSearchHistory && !nativeOpaqueHistory) continue
    const carriers = carriersByMessageIndex.get(messageIndex) ?? []
    if (carriers.length > 0) {
      if (nativeOpaqueHistory) {
        throwCarrierError("gateway and native Web Search history cannot mix")
      }
      continue
    }
    if (resumedResultMessageIndexes.has(messageIndex)) {
      if (nativeOpaqueHistory) {
        throwCarrierError("gateway and native Web Search history cannot mix")
      }
      continue
    }
    if (!nativeOpaqueHistory && hasMarkerlessErrorResult(assistantMessage)) {
      throwCarrierError("markerless Web Search error provenance is ambiguous")
    }
    if (context.destination === "messages") {
      if (!nativeOpaqueHistory) {
        throwCarrierError(
          "ambiguous synthetic Web Search history cannot enter Messages",
        )
      }
      continue
    }
    if (nativeOpaqueHistory) {
      throwCarrierError("native Web Search history cannot cross adapters")
    }
    assertCompleteMarkerlessHistory(assistantMessage)
  }

  if (located.length === 0) return EMPTY_SANITIZATION

  const restoredTurns = validatedStates.map((state) =>
    Object.freeze({
      continuation:
        state.completionMessageIndex === null ?
          state.envelope.continuation
        : ({ kind: "complete" } as const),
      messageIndex: state.carrier.messageIndex,
      outputItems: state.restoredOutputItems,
    }),
  )
  const pendingStates = validatedStates.filter((state) => state.remainsPending)
  if (pendingStates.length > 1) {
    throwCarrierError("multiple pending Web Search continuations are ambiguous")
  }
  const pendingState = pendingStates[0]
  const resumedPendingServerToolUseIds =
    pendingState && pendingState.envelope.continuation.kind !== "complete" ?
      pendingState.envelope.continuation.pending_server_tool_use_ids
    : Object.freeze([])

  for (const restored of restoredTurns) {
    const message = payload.messages[restored.messageIndex]
    if (message.role !== "assistant") throwCarrierError("malformed-placement")
    message.content = []
  }

  return Object.freeze({
    restoredTurns: Object.freeze(restoredTurns),
    resumedPendingServerToolUseIds: Object.freeze([
      ...resumedPendingServerToolUseIds,
    ]),
    turnPhase:
      resumedPendingServerToolUseIds.length > 0 ? "resumed" : "initial",
  })
}

export const webSearchCarrierSanitizer =
  Object.freeze<WebSearchCarrierSanitizer>({
    sanitize: sanitizeWebSearchCarrier,
  })
