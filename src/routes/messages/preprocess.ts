import type { Model } from "~/services/copilot/get-models"

import type {
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "./anthropic-types"

const compactSystemPromptStart =
  "You are a helpful AI assistant tasked with summarizing conversations"
const compactTextOnlyGuard =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools."
const compactSummaryPromptStart =
  "Your task is to create a detailed summary of the conversation so far"
const compactMessageSections = ["Pending Tasks:", "Current Work:"] as const
export const TOOL_REFERENCE_TURN_BOUNDARY = "Tool loaded."

const getCompactCandidateText = (message: AnthropicMessage): string => {
  if (message.role !== "user") {
    return ""
  }

  if (typeof message.content === "string") {
    return message.content
  }

  return message.content
    .filter((block): block is AnthropicTextBlock => block.type === "text")
    .map((block) =>
      block.text.startsWith("<system-reminder>") ? "" : block.text,
    )
    .filter((text) => text.length > 0)
    .join("\n\n")
}

const isCompactMessage = (lastMessage: AnthropicMessage): boolean => {
  const text = getCompactCandidateText(lastMessage)
  if (!text) {
    return false
  }

  return (
    text.includes(compactTextOnlyGuard)
    && text.includes(compactSummaryPromptStart)
    && compactMessageSections.some((section) => text.includes(section))
  )
}

export const isCompactRequest = (
  anthropicPayload: AnthropicMessagesPayload,
): boolean => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return true
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    return system.startsWith(compactSystemPromptStart)
  }
  if (!Array.isArray(system)) return false

  return system.some(
    (msg) =>
      typeof msg.text === "string"
      && msg.text.startsWith(compactSystemPromptStart),
  )
}

export const stripToolReferenceTurnBoundary = (
  anthropicPayload: AnthropicMessagesPayload,
): void => {
  for (const msg of anthropicPayload.messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue

    const hasToolReference = msg.content.some(
      (block) => block.type === "tool_result" && hasToolRef(block),
    )
    if (!hasToolReference) continue

    msg.content = msg.content.filter(
      (block) =>
        block.type !== "text"
        || block.text.trim() !== TOOL_REFERENCE_TURN_BOUNDARY,
    )
  }
}

const hasToolRef = (block: AnthropicToolResultBlock) => {
  return (
    Array.isArray(block.content)
    && block.content.some((c) => c.type === "tool_reference")
  )
}

// Strip cache_control from system content blocks as the
// Copilot Messages API does not support them (rejects extra fields like scope).
// commit by nicktogo
const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      const systemBlock = block as AnthropicTextBlock & {
        cache_control?: Record<string, unknown>
      }
      const cacheControl = systemBlock.cache_control
      if (cacheControl && typeof cacheControl === "object") {
        const { scope, ...rest } = cacheControl
        systemBlock.cache_control = rest
      }
    }
  }
}

// Pre-request processing: filter thinking blocks for Claude models so only
// valid thinking blocks are sent to the Copilot Messages API.
const filterAssistantThinkingBlocks = (
  payload: AnthropicMessagesPayload,
): void => {
  for (const msg of payload.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      msg.content = msg.content.filter((block) => {
        if (block.type !== "thinking") return true
        return (
          block.thinking
          && block.thinking !== "Thinking..."
          && block.signature
          && !block.signature.includes("@")
        )
      })
    }
  }
}

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  stripCacheControl(payload)
  filterAssistantThinkingBlocks(payload)

  // https://platform.claude.com/docs/en/build-with-claude/extended-thinking#extended-thinking-with-tool-use
  // Using tool_choice: {"type": "any"} or tool_choice: {"type": "tool", "name": "..."} will result in an error because these options force tool use, which is incompatible with extended thinking.
  const toolChoice = payload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"

  if (selectedModel?.capabilities.supports.adaptive_thinking && !disableThink) {
    // Only inject adaptive thinking as default when client didn't specify thinking
    if (!payload.thinking) {
      payload.thinking = {
        type: "adaptive",
      }
    }

    // When thinking is active (not disabled), temperature must be omitted
    // and effort should be set
    if (payload.thinking.type !== "disabled") {
      delete payload.temperature
      payload.output_config = {
        ...payload.output_config,
        effort: payload.output_config?.effort ?? "high",
      }
    }
  }
}
