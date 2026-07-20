// Anthropic API Types

import type { MessageReasoningEffort } from "~/lib/reasoning-effort"

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicInputMessage>
  cache_control?: AnthropicCacheControl | null
  system?: string | Array<AnthropicTextBlock>
  stop_sequences?: Array<string>
  stream?: boolean
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: "auto" | "any" | "tool" | "none"
    name?: string
    disable_parallel_tool_use?: boolean
  }
  max_tokens: number
  thinking?:
    | {
        type: "enabled"
        budget_tokens?: number
        display?: string
      }
    | {
        type: "adaptive"
        display?: string
        budget_tokens?: never
      }
    | {
        type: "disabled"
        budget_tokens?: never
        display?: never
      }
  service_tier?: "auto" | "standard_only"
  output_config?: {
    effort?: MessageReasoningEffort
    format?: BetaJSONOutputFormat | null
  }
  metadata?: {
    user_id?: string
  }
  temperature?: number
}

export interface BetaJSONOutputFormat {
  schema: { [key: string]: unknown }

  type: "json_schema"
}

export interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: string
  [key: string]: unknown
}

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicImageBlock {
  type: "image"
  source:
    | {
        type: "base64"
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        data: string
      }
    | {
        type: "url"
        url: string
      }
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicDocumentBlock {
  type: "document"
  source:
    | {
        type: "base64"
        media_type: "application/pdf"
        data: string
      }
    | {
        type: "url"
        url: string
      }
  title?: string | null
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicDocumentContainerBlock {
  type: "document"
  source:
    | {
        type: "text"
        media_type: "text/plain"
        data: string
      }
    | {
        type: "content"
        content:
          | string
          | Array<
              AnthropicTextBlock | AnthropicImageBlock | AnthropicFileImageBlock
            >
      }
  title?: string | null
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicFileSource {
  type: "file"
  file_id: string
}

export interface AnthropicFileImageBlock {
  type: "image"
  source: AnthropicFileSource
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicFileDocumentBlock {
  type: "document"
  source: AnthropicFileSource
  title?: string | null
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicToolReferenceBlock {
  type: "tool_reference"
  tool_name: string
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicUnknownToolResultContentBlock {
  type: string
  cache_control?: AnthropicCacheControl | null
  [key: string]: unknown
}

export type AnthropicToolResultContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicFileImageBlock
  | AnthropicDocumentBlock
  | AnthropicFileDocumentBlock
  | AnthropicDocumentContainerBlock
  | AnthropicToolReferenceBlock
  | AnthropicUnknownToolResultContentBlock

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const isAnthropicTextBlock = (
  block: unknown,
): block is AnthropicTextBlock =>
  isRecord(block) && block.type === "text" && typeof block.text === "string"

export const isAnthropicImageBlock = (
  block: unknown,
): block is AnthropicImageBlock => {
  if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) {
    return false
  }

  return block.source.type === "url" ?
      typeof block.source.url === "string"
    : block.source.type === "base64"
        && typeof block.source.media_type === "string"
        && ANTHROPIC_IMAGE_MEDIA_TYPES.has(block.source.media_type)
        && typeof block.source.data === "string"
}

export const isAnthropicDocumentBlock = (
  block: unknown,
): block is AnthropicDocumentBlock => {
  if (
    !isRecord(block)
    || block.type !== "document"
    || !isRecord(block.source)
  ) {
    return false
  }

  return block.source.type === "url" ?
      typeof block.source.url === "string"
    : block.source.type === "base64"
        && block.source.media_type === "application/pdf"
        && typeof block.source.data === "string"
}

export const isAnthropicDocumentContainerBlock = (
  block: unknown,
): block is AnthropicDocumentContainerBlock => {
  if (
    !isRecord(block)
    || block.type !== "document"
    || !isRecord(block.source)
  ) {
    return false
  }
  if (block.source.type === "text") {
    return (
      block.source.media_type === "text/plain"
      && typeof block.source.data === "string"
    )
  }
  return (
    block.source.type === "content"
    && (typeof block.source.content === "string"
      || (Array.isArray(block.source.content)
        && block.source.content.every(
          (contentBlock) =>
            isAnthropicTextBlock(contentBlock)
            || isAnthropicImageBlock(contentBlock)
            || isAnthropicFileImageBlock(contentBlock),
        )))
  )
}

export const isAnthropicFileSource = (
  source: unknown,
): source is AnthropicFileSource =>
  isRecord(source)
  && source.type === "file"
  && typeof source.file_id === "string"

export const isAnthropicFileImageBlock = (
  block: unknown,
): block is AnthropicFileImageBlock =>
  isRecord(block)
  && block.type === "image"
  && isAnthropicFileSource(block.source)

export const isAnthropicFileDocumentBlock = (
  block: unknown,
): block is AnthropicFileDocumentBlock =>
  isRecord(block)
  && block.type === "document"
  && isAnthropicFileSource(block.source)

export const isAnthropicToolReferenceBlock = (
  block: unknown,
): block is AnthropicToolReferenceBlock =>
  isRecord(block)
  && block.type === "tool_reference"
  && typeof block.tool_name === "string"

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | Array<AnthropicToolResultContentBlock>
  is_error?: boolean
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: AnthropicCacheControl | null
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature: string
}

export type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicFileImageBlock
  | AnthropicDocumentBlock
  | AnthropicFileDocumentBlock
  | AnthropicDocumentContainerBlock
  | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock

export interface AnthropicUserMessage {
  role: "user"
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: "assistant"
  content: string | Array<AnthropicAssistantContentBlock>
}

export interface AnthropicSystemMessage {
  role: "system"
  content: string | Array<AnthropicTextBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage
export type AnthropicInputMessage = AnthropicMessage | AnthropicSystemMessage

export interface AnthropicCustomTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  defer_loading?: boolean
  cache_control?: AnthropicCacheControl | null
  type?: never
  max_uses?: never
  allowed_callers?: never
  response_inclusion?: never
  allowed_domains?: never
  blocked_domains?: never
  user_location?: never
}

export type AnthropicWebSearchCaller = "direct" | `code_execution_${number}`

export interface AnthropicWebSearchTool {
  name: "web_search"
  type: `web_search_${number}`
  description?: never
  input_schema?: never
  defer_loading?: never
  cache_control?: never
  max_uses?: number
  allowed_callers?: Array<AnthropicWebSearchCaller>
  response_inclusion?: "full" | "excluded"
  allowed_domains?: Array<string>
  blocked_domains?: Array<string>
  user_location?: Record<string, unknown>
}

export type AnthropicTool = AnthropicCustomTool | AnthropicWebSearchTool

export const isAnthropicCustomTool = (
  tool: AnthropicTool,
): tool is AnthropicCustomTool => tool.input_schema !== undefined

// --- Web search result blocks (Anthropic server tool shape) ---------------
// Emitted in the assistant response when the proxy fulfills a web_search tool.

export interface AnthropicWebSearchResultItem {
  type: "web_search_result"
  url: string
  title: string
  page_age?: string | null
  encrypted_content?: string
}

export interface AnthropicServerToolUseBlock {
  type: "server_tool_use"
  id: string
  name: "web_search"
  input: Record<string, unknown>
}

export interface AnthropicWebSearchToolResultErrorBlock {
  type: "web_search_tool_result_error"
  error_code: string
}

export interface AnthropicWebSearchToolResultBlock {
  type: "web_search_tool_result"
  tool_use_id: string
  content:
    | Array<AnthropicWebSearchResultItem>
    | AnthropicWebSearchToolResultErrorBlock
}

export type AnthropicWebSearchContentBlock =
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  service_tier?: "standard" | "priority" | "batch"
  server_tool_use?: {
    web_search_requests?: number
  }
}

export interface CopilotUsage {
  total_nano_aiu?: number | null
}

export type AnthropicResponseContentBlock =
  | AnthropicAssistantContentBlock
  | AnthropicWebSearchContentBlock

export interface AnthropicResponse<
  TContentBlock extends
    AnthropicResponseContentBlock = AnthropicResponseContentBlock,
> {
  id: string
  type: "message"
  role: "assistant"
  content: Array<TContentBlock>
  copilot_usage?: CopilotUsage | null
  model: string
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null
  stop_sequence: string | null
  usage: AnthropicUsage
}

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: "message_start"
  message: Omit<
    AnthropicResponse,
    "content" | "stop_reason" | "stop_sequence"
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: "content_block_start"
  index: number
  content_block:
    | { type: "text"; text: string }
    | (Omit<AnthropicToolUseBlock, "input"> & {
        input: Record<string, unknown>
      })
    | { type: "thinking"; thinking: string }
    | AnthropicServerToolUseBlock
    | AnthropicWebSearchToolResultBlock
}

export interface AnthropicContentBlockDeltaEvent {
  type: "content_block_delta"
  index: number
  delta:
    | { type: "text_delta"; text: string }
    | { type: "input_json_delta"; partial_json: string }
    | { type: "thinking_delta"; thinking: string }
    | { type: "signature_delta"; signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: "content_block_stop"
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: "message_delta"
  copilot_usage?: CopilotUsage | null
  delta: {
    stop_reason?: AnthropicResponse["stop_reason"]
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: "message_stop"
}

export interface AnthropicPingEvent {
  type: "ping"
}

export interface AnthropicErrorEvent {
  type: "error"
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  thinkingBlockOpen: boolean
  emitThinking?: boolean
  pendingMessageDelta?: AnthropicMessageDeltaEvent
  deferredContent?: string
  toolCalls: {
    [openAIToolIndex: number]: {
      id?: string
      name?: string
      arguments: string
    }
  }
}
