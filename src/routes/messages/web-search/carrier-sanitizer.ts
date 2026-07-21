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
  type WebSearchHistoryOutputItem,
} from "./history-carrier"
import { projectWebSearchSyntheticHistory } from "./reconstruction"

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
  readonly messageIndex: number
  readonly outputItems: ReadonlyArray<WebSearchHistoryOutputItem>
}

export interface WebSearchCarrierSanitization {
  readonly restoredTurns: ReadonlyArray<RestoredWebSearchTurn>
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

const throwCarrierError = (reason: string): never => {
  throw createMessagesInvalidRequestError(
    `Web Search history carrier rejected: ${reason}`,
  )
}

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

  const seenMessageIndexes = new Set<number>()
  const restoredTurns = new Array<RestoredWebSearchTurn>()
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
    if (accepted.envelope.continuation.kind !== "complete") {
      throwCarrierError("unsupported-continuation")
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
    restoredTurns.push(
      Object.freeze({
        messageIndex: carrier.messageIndex,
        outputItems: accepted.envelope.output_items,
      }),
    )
  }

  for (const restored of restoredTurns) {
    const message = payload.messages[restored.messageIndex]
    if (message.role !== "assistant") throwCarrierError("malformed-placement")
    message.content = []
  }

  return Object.freeze({ restoredTurns: Object.freeze(restoredTurns) })
}

export const webSearchCarrierSanitizer =
  Object.freeze<WebSearchCarrierSanitizer>({
    sanitize: sanitizeWebSearchCarrier,
  })
