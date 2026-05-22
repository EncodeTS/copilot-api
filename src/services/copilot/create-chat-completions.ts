import consola from "consola"
import { events } from "fetch-event-stream"

import type { CompactType } from "~/lib/compact"
import type { SubagentMarker } from "~/lib/subagent"

import {
  copilotBaseUrl,
  copilotHeaders,
  prepareForCompact,
  prepareInteractionHeaders,
} from "~/lib/api-config"
import { logCopilotRateLimits } from "~/lib/copilot-rate-limit"
import { HTTPError, logUpstreamError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ChatCompletionsOptions {
  subagentMarker?: SubagentMarker | null
  requestId: string
  sessionId?: string
  compactType?: CompactType
}

export const hasAgentInitiator = (messages: Array<Message>): boolean => {
  const lastMessage = messages.at(-1)
  return Boolean(
    lastMessage && ["assistant", "tool"].includes(lastMessage.role),
  )
}

export const prepareChatCompletionsHeaders = (
  payload: ChatCompletionsPayload,
  options: ChatCompletionsOptions,
): Record<string, string> => {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, options.requestId, enableVision),
    "x-initiator": hasAgentInitiator(payload.messages) ? "agent" : "user",
  }

  prepareInteractionHeaders(
    options.sessionId,
    Boolean(options.subagentMarker),
    headers,
  )

  prepareForCompact(headers, options.compactType)

  return headers
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
  options: ChatCompletionsOptions,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const headers = prepareChatCompletionsHeaders(payload, options)

  consola.log(`<-- model: ${payload.model}`)

  const response = await globalThis.fetch(
    `${copilotBaseUrl(state)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  )

  logCopilotRateLimits(response.headers)

  if (!response.ok) {
    const debugResponse = await logUpstreamError(
      "POST /chat/completions",
      response,
      {
        requestId: options.requestId,
        model: payload.model,
        stream: Boolean(payload.stream),
        tools: payload.tools?.length ?? 0,
      },
    )
    throw new HTTPError("Failed to create chat completions", debugResponse)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cache_creation_input_tokens?: number
      cached_tokens?: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

export interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
}

export interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cache_creation_input_tokens?: number
      cached_tokens?: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  reasoning_text?: string | null
  reasoning_content?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  [key: string]: unknown

  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
  stream_options?: {
    include_usage?: boolean | null
  } | null
  thinking_budget?: number
  top_k?: number | null
  parallel_tool_calls?: boolean | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  reasoning_content?: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  copilot_cache_control?: CopilotCacheControl
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart | FilePart

export interface CacheControl {
  type: "ephemeral"
}

export interface CopilotCacheControl {
  type: "ephemeral"
}

export interface TextPart {
  type: "text"
  text: string
  cache_control?: CacheControl
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
  cache_control?: CacheControl
}

export interface FilePart {
  type: "file"
  file: {
    file_data: string
    filename?: string
  }
  cache_control?: CacheControl
}
