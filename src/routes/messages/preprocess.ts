import type { Model } from "~/services/copilot/get-models"

import {
  COMPACT_AUTO_CONTINUE,
  COMPACT_REQUEST,
  compactAutoContinuePromptStarts,
  compactMessageSections,
  compactSummaryPromptStart,
  compactSystemPromptStarts,
  compactTextOnlyGuard,
  type CompactType,
} from "~/lib/compact"
import { getReasoningEffortForModel } from "~/lib/config"
import { normalizeSdkModelId } from "~/lib/models"

import type {
  AnthropicInputMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicUserMessage,
} from "./anthropic-types"

const SYSTEM_REMINDER_START = "<system-reminder>"
const SYSTEM_REMINDER_END = "</system-reminder>"
const SUBAGENT_START_HOOK_ADDITIONAL_PREFIX = "SubagentStart hook additional"

const IDE_EXECUTE_CODE_TOOL = "mcp__ide__executeCode"
const IDE_GET_DIAGNOSTICS_TOOL = "mcp__ide__getDiagnostics"
const IDE_GET_DIAGNOSTICS_DESCRIPTION =
  "Get language diagnostics from VS Code. Returns errors, warnings, information, and hints for files in the workspace."
const CLAUDE_CODE_BILLING_HEADER_PREFIX = "x-anthropic-billing-header:"
const CLAUDE_CODE_CCH_SEGMENT_PATTERN = /(^|;\s*)cch=[^;]+;/u

const createTextBlock = (text: string): AnthropicTextBlock => ({
  type: "text",
  text,
})

const appendTextSegment = (base: string, addition: string): string => {
  if (base.length === 0) {
    return addition
  }
  if (addition.length === 0) {
    return base
  }

  return `${base}\n\n${addition}`
}

const ensureSystemReminderText = (text: string): string => {
  if (text.startsWith(SYSTEM_REMINDER_START)) {
    return text
  }

  return `${SYSTEM_REMINDER_START}\n${text.trim()}\n${SYSTEM_REMINDER_END}`
}

const normalizeSystemStringForMerge = (
  text: string,
): string | Array<AnthropicTextBlock> => {
  if (!text.startsWith(SUBAGENT_START_HOOK_ADDITIONAL_PREFIX)) {
    return ensureSystemReminderText(text)
  }

  const lineBreakMatch = /\r?\n/.exec(text)
  if (!lineBreakMatch) {
    return [createTextBlock(ensureSystemReminderText(text))]
  }

  const firstLine = text.slice(0, lineBreakMatch.index)
  const rest = text.slice(lineBreakMatch.index + lineBreakMatch[0].length)
  return [
    createTextBlock(ensureSystemReminderText(firstLine)),
    ...(rest.length > 0 ?
      [createTextBlock(ensureSystemReminderText(rest))]
    : []),
  ]
}

const normalizeSystemContentForMerge = (
  content: string | Array<AnthropicTextBlock>,
): string | Array<AnthropicTextBlock> => {
  if (typeof content === "string") {
    return normalizeSystemStringForMerge(content)
  }

  return content.map((block) =>
    block.text.startsWith(SYSTEM_REMINDER_START) ?
      block
    : {
        ...block,
        text: ensureSystemReminderText(block.text),
      },
  )
}

const toSystemTextBlocks = (
  content: string | Array<AnthropicTextBlock>,
): Array<AnthropicTextBlock> => {
  return typeof content === "string" ? [createTextBlock(content)] : [...content]
}

const mergeSystemPromptContent = (
  current: string | Array<AnthropicTextBlock> | undefined,
  addition: string | Array<AnthropicTextBlock>,
): string | Array<AnthropicTextBlock> => {
  if (current === undefined) {
    return typeof addition === "string" ? addition : [...addition]
  }

  if (typeof current === "string" && typeof addition === "string") {
    return appendTextSegment(current, addition)
  }

  return [...toSystemTextBlocks(current), ...toSystemTextBlocks(addition)]
}

const prependSystemContentToUserMessage = (
  message: AnthropicUserMessage,
  addition: string | Array<AnthropicTextBlock>,
): void => {
  if (typeof message.content === "string" && typeof addition === "string") {
    message.content = appendTextSegment(addition, message.content)
    return
  }

  if (Array.isArray(message.content)) {
    const lastToolResultIndex = message.content.findLastIndex(
      (block) => block.type === "tool_result",
    )
    if (lastToolResultIndex >= 0) {
      message.content = [
        ...message.content.slice(0, lastToolResultIndex + 1),
        ...toSystemTextBlocks(addition),
        ...message.content.slice(lastToolResultIndex + 1),
      ]
      return
    }
  }

  message.content = [
    ...toSystemTextBlocks(addition),
    ...(typeof message.content === "string" ?
      [createTextBlock(message.content)]
    : message.content),
  ]
}

const normalizeClaudeCodeBillingHeader = (text: string): string => {
  if (!text.startsWith(CLAUDE_CODE_BILLING_HEADER_PREFIX)) {
    return text
  }

  return text.replace(CLAUDE_CODE_CCH_SEGMENT_PATTERN, "$1cch=<stable>;")
}

export const normalizeClaudeCodeBillingHeaderInSystem = (
  payload: AnthropicMessagesPayload,
): void => {
  const system = payload.system
  if (!system) {
    return
  }

  if (typeof system === "string") {
    payload.system = normalizeClaudeCodeBillingHeader(system)
    return
  }

  if (system.length === 0) {
    return
  }

  payload.system = system.map((block, index) =>
    index === 0 ?
      { ...block, text: normalizeClaudeCodeBillingHeader(block.text) }
    : block,
  )
}

export const normalizeSystemMessages = (
  payload: AnthropicMessagesPayload,
): void => {
  normalizeClaudeCodeBillingHeaderInSystem(payload)

  if (!payload.messages.some((msg) => msg.role === "system")) {
    return
  }

  const normalizedMessages: Array<AnthropicMessage> = []
  let system = payload.system

  for (const message of payload.messages) {
    if (message.role === "system") {
      const normalizedContent = normalizeSystemContentForMerge(message.content)
      const previousMessage = normalizedMessages.at(-1)
      if (previousMessage?.role === "user") {
        prependSystemContentToUserMessage(previousMessage, normalizedContent)
      } else if (!previousMessage) {
        system = mergeSystemPromptContent(system, normalizedContent)
      }
      continue
    }

    normalizedMessages.push(message)
  }

  payload.messages = normalizedMessages
  payload.system = system
}

const isVersionAtLeast = (
  version: string,
  minimumMajor: number,
  minimumMinor: number,
): boolean => {
  const [majorPart, minorPart = "0"] = version.split(".")
  const major = Number.parseInt(majorPart, 10)
  const minor = Number.parseInt(minorPart, 10)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) {
    return false
  }

  return (
    major > minimumMajor || (major === minimumMajor && minor >= minimumMinor)
  )
}

const shouldSummarizeThinkingDisplayForModel = (model: string): boolean => {
  const normalized = normalizeSdkModelId(model)
  return Boolean(normalized && isVersionAtLeast(normalized.version, 4, 7))
}

const shouldUseAdaptiveThinkingForModel = (model: string): boolean => {
  const normalized = normalizeSdkModelId(model)
  return Boolean(
    normalized
      && normalized.family === "opus"
      && isVersionAtLeast(normalized.version, 4, 7),
  )
}

const getCompactCandidateText = (message: AnthropicInputMessage): string => {
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

const isCompactMessage = (lastMessage: AnthropicInputMessage): boolean => {
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

const isCompactAutoContinueMessage = (
  lastMessage: AnthropicInputMessage,
): boolean => {
  const text = getCompactCandidateText(lastMessage)
  return (
    Boolean(text)
    && compactAutoContinuePromptStarts.some((promptStart) =>
      text.startsWith(promptStart),
    )
  )
}

export const getCompactType = (
  anthropicPayload: AnthropicMessagesPayload,
): CompactType => {
  const lastMessage = anthropicPayload.messages.at(-1)
  if (lastMessage && isCompactMessage(lastMessage)) {
    return COMPACT_REQUEST
  }

  if (lastMessage && isCompactAutoContinueMessage(lastMessage)) {
    return COMPACT_AUTO_CONTINUE
  }

  const system = anthropicPayload.system
  if (typeof system === "string") {
    const hasCompactSystemPrompt = compactSystemPromptStarts.some(
      (promptStart) => system.startsWith(promptStart),
    )
    return hasCompactSystemPrompt ? COMPACT_REQUEST : 0
  }
  if (!Array.isArray(system)) return 0

  const hasCompactSystemPrompt = system.some(
    (msg) =>
      typeof msg.text === "string"
      && compactSystemPromptStarts.some((promptStart) =>
        msg.text.startsWith(promptStart),
      ),
  )
  if (hasCompactSystemPrompt) {
    return COMPACT_REQUEST
  }

  return 0
}

// Align IDE metadata with VS Code Copilot while allowing native Messages
// callers to preserve executeCode when the upstream model supports it.
export const sanitizeIdeTools = (
  payload: AnthropicMessagesPayload,
  options: { preserveExecuteCode?: boolean } = {},
): void => {
  if (!payload.tools || payload.tools.length === 0) {
    return
  }

  payload.tools = payload.tools.flatMap((tool) => {
    if (
      tool.name === IDE_EXECUTE_CODE_TOOL
      && !tool.defer_loading
      && !options.preserveExecuteCode
    ) {
      return []
    }

    if (tool.name === IDE_GET_DIAGNOSTICS_TOOL) {
      return [
        {
          ...tool,
          description: IDE_GET_DIAGNOSTICS_DESCRIPTION,
        },
      ]
    }

    return [tool]
  })
}

// Strip cache_control from system content blocks as the
// Copilot Messages API does not support them (rejects extra fields like scope).
// commit by nicktogo
const stripCacheControl = (payload: AnthropicMessagesPayload): void => {
  if (Array.isArray(payload.system)) {
    for (const block of payload.system) {
      const cacheControl = block.cache_control
      if (cacheControl && typeof cacheControl === "object") {
        const { scope, ...rest } = cacheControl
        block.cache_control = rest
      }
    }
  }
}

// Port top-level cache_control onto the last cacheable block as a lossless
// polyfill, then drop the top-level field.
const applyTopLevelCacheControl = (payload: AnthropicMessagesPayload): void => {
  const topLevel = payload.cache_control
  if (!topLevel || typeof topLevel !== "object") {
    if (topLevel !== undefined) {
      delete payload.cache_control
    }
    return
  }

  delete payload.cache_control

  for (let m = payload.messages.length - 1; m >= 0; m--) {
    const message = payload.messages[m]

    if (typeof message.content === "string") {
      message.content = [
        {
          type: "text",
          text: message.content,
          cache_control: { ...topLevel },
        },
      ]
      return
    }

    if (!Array.isArray(message.content)) continue

    for (let b = message.content.length - 1; b >= 0; b--) {
      const block = message.content[b]
      if (
        block.type !== "text"
        && block.type !== "image"
        && block.type !== "tool_use"
        && block.type !== "tool_result"
      ) {
        continue
      }
      block.cache_control ??= { ...topLevel }
      return
    }
  }
}

// Strip per-tool eager_input_streaming.
const stripToolEagerInputStreaming = (
  payload: AnthropicMessagesPayload,
): void => {
  if (!payload.tools || payload.tools.length === 0) return

  for (const tool of payload.tools) {
    const extended = tool as typeof tool & { eager_input_streaming?: unknown }
    if ("eager_input_streaming" in extended) {
      delete extended.eager_input_streaming
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

const resolveEffortForThinkingBudget = (
  budgetTokens: number | undefined,
  maxThinkingBudget: number | undefined,
  supportedEfforts: Array<string> | undefined,
): string | undefined => {
  if (
    typeof budgetTokens !== "number"
    || typeof maxThinkingBudget !== "number"
    || maxThinkingBudget <= 0
    || !supportedEfforts
    || supportedEfforts.length === 0
  ) {
    return undefined
  }

  const orderedEfforts = supportedEfforts.filter(
    (effort) => effort !== "none" && effort !== "minimal",
  )
  if (orderedEfforts.length === 0) {
    return undefined
  }

  const ratio = Math.max(0, Math.min(1, budgetTokens / maxThinkingBudget))
  const index = Math.min(
    orderedEfforts.length - 1,
    Math.max(0, Math.ceil(ratio * orderedEfforts.length) - 1),
  )
  return orderedEfforts[index]
}

export const prepareMessagesApiPayload = (
  payload: AnthropicMessagesPayload,
  selectedModel?: Model,
): void => {
  stripCacheControl(payload)
  applyTopLevelCacheControl(payload)
  stripToolEagerInputStreaming(payload)
  filterAssistantThinkingBlocks(payload)

  // Adaptive thinking supports forced tool choice. Older enabled/budget shapes
  // still need to be normalized before the forced choice is forwarded.
  const toolChoice = payload.tool_choice
  const disableThink = toolChoice?.type === "any" || toolChoice?.type === "tool"
  const requestedThinkingBudget =
    payload.thinking?.type === "enabled" ?
      payload.thinking.budget_tokens
    : undefined

  if (
    selectedModel?.capabilities.supports.adaptive_thinking
    && (!disableThink || payload.thinking !== undefined)
  ) {
    if (!payload.thinking) {
      payload.thinking = {
        type: "adaptive",
      }
      // align with vscode copilot
      payload.thinking.display = "summarized"
    } else if (payload.thinking.type === "disabled") {
      delete payload.thinking.display
      delete payload.thinking.budget_tokens
      return
    } else if (shouldUseAdaptiveThinkingForModel(payload.model)) {
      payload.thinking = {
        type: "adaptive",
        display: payload.thinking.display ?? "summarized",
      }
    } else if (
      shouldSummarizeThinkingDisplayForModel(payload.model)
      && !payload.thinking.display
    ) {
      payload.thinking.display = "summarized"
    }

    if (payload.thinking.type !== "adaptive") {
      return
    }
    const maxThinkingBudget =
      selectedModel.capabilities.supports.max_thinking_budget
    const reasoningEffort = selectedModel.capabilities.supports.reasoning_effort
    let effort: string =
      payload.output_config?.effort
      ?? resolveEffortForThinkingBudget(
        requestedThinkingBudget,
        maxThinkingBudget,
        reasoningEffort,
      )
      ?? getReasoningEffortForModel(payload.model)
    if (effort === "none" || effort === "minimal") {
      effort = "low"
    }
    if (reasoningEffort && !reasoningEffort.includes(effort)) {
      effort = reasoningEffort.at(-1) as
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max"
    }
    payload.output_config = {
      ...payload.output_config,
      effort: effort as "low" | "medium" | "high" | "xhigh" | "max",
    }
  }

  const modelSupports = selectedModel?.capabilities.supports
  if (!modelSupports?.adaptive_thinking) {
    const reasoningEfforts = modelSupports?.reasoning_effort
    if (!reasoningEfforts || reasoningEfforts.length === 0) {
      if (payload.output_config?.effort) {
        delete payload.output_config.effort
        if (Object.keys(payload.output_config).length === 0) {
          delete payload.output_config
        }
      }
    }

    if (disableThink) {
      delete payload.thinking
    } else {
      const budgetTokens = modelSupports?.max_thinking_budget ?? 4096
      if (payload.thinking?.type === "adaptive") {
        payload.thinking = {
          type: "enabled",
          budget_tokens: budgetTokens - 1,
        }
      }
    }
  }
}
