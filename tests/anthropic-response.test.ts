import { describe, test, expect } from "bun:test"
import { z } from "zod"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import { type AnthropicStreamState } from "~/routes/messages/anthropic-types"
import { translateToAnthropic } from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"

const anthropicUsageSchema = z.object({
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
})

const anthropicContentBlockTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const anthropicContentBlockToolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.any()),
})

const anthropicMessageResponseSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.array(
    z.union([
      anthropicContentBlockTextSchema,
      anthropicContentBlockToolUseSchema,
    ]),
  ),
  model: z.string(),
  stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
})

/**
 * Validates if a response payload conforms to the Anthropic Message shape.
 * @param payload The response payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidAnthropicResponse(payload: unknown): boolean {
  return anthropicMessageResponseSchema.safeParse(payload).success
}

const anthropicStreamEventSchema = z.looseObject({
  type: z.enum([
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]),
})

function isValidAnthropicStreamEvent(payload: unknown): boolean {
  return anthropicStreamEventSchema.safeParse(payload).success
}

describe("OpenAI to Anthropic Non-Streaming Response Translation", () => {
  test("should translate a simple text response correctly", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 12,
        total_tokens: 21,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.id).toBe("chatcmpl-123")
    expect(anthropicResponse.stop_reason).toBe("end_turn")
    expect(anthropicResponse.usage.input_tokens).toBe(9)
    expect(anthropicResponse.content[0].type).toBe("text")
    if (anthropicResponse.content[0].type === "text") {
      expect(anthropicResponse.content[0].text).toBe(
        "Hello! How can I help you today?",
      )
    } else {
      throw new Error("Expected text block")
    }
  })

  test("should translate a response with tool calls", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-456",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_current_weather",
                  arguments: '{"location": "Boston, MA"}',
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 30,
        completion_tokens: 20,
        total_tokens: 50,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)

    expect(anthropicResponse.stop_reason).toBe("tool_use")
    expect(anthropicResponse.content[0].type).toBe("tool_use")
    if (anthropicResponse.content[0].type === "tool_use") {
      expect(anthropicResponse.content[0].id).toBe("call_abc")
      expect(anthropicResponse.content[0].name).toBe("get_current_weather")
      expect(anthropicResponse.content[0].input).toEqual({
        location: "Boston, MA",
      })
    } else {
      throw new Error("Expected tool_use block")
    }
  })

  test("should normalize empty and malformed tool arguments to objects", () => {
    const createResponse = (
      argumentsValue: string,
    ): ChatCompletionResponse => ({
      id: "chatcmpl-tool-arguments",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_tool",
                type: "function",
                function: {
                  name: "tool",
                  arguments: argumentsValue,
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
    })

    const empty = translateToAnthropic(createResponse(""))
    const malformed = translateToAnthropic(createResponse('{"value":'))

    expect(empty.content[0]).toMatchObject({
      type: "tool_use",
      input: {},
    })
    expect(malformed.content[0]).toMatchObject({
      type: "tool_use",
      input: {
        raw_arguments: '{"value":',
      },
    })
  })

  test("should suppress thinking blocks when the client disables thinking", () => {
    const response: ChatCompletionResponse = {
      id: "chatcmpl-disabled-thinking",
      object: "chat.completion",
      created: 1677652288,
      model: "gemini-3.5-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "OK",
            reasoning_text: "hidden reasoning",
            reasoning_opaque: "opaque",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    const translated = translateToAnthropic(response, {
      includeThinking: false,
    })
    expect(translated.content).toEqual([{ type: "text", text: "OK" }])
  })

  test("should translate a response stopped due to length", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-789",
      object: "chat.completion",
      created: 1677652288,
      model: "gpt-4o-2024-05-13",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "This is a very long response that was cut off...",
          },
          finish_reason: "length",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2048,
        total_tokens: 2058,
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(isValidAnthropicResponse(anthropicResponse)).toBe(true)
    expect(anthropicResponse.stop_reason).toBe("max_tokens")
  })

  test("should translate OpenAI cache creation usage details", () => {
    const openAIResponse: ChatCompletionResponse = {
      id: "chatcmpl-cache",
      object: "chat.completion",
      created: 1677652288,
      model: "qwen-plus",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "cached answer",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: {
          cache_creation_input_tokens: 20,
          cached_tokens: 12,
        },
      },
    }

    const anthropicResponse = translateToAnthropic(openAIResponse)

    expect(anthropicResponse.usage).toEqual({
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 12,
      input_tokens: 68,
      output_tokens: 10,
    })
  })
})

describe("OpenAI to Anthropic Streaming Response Translation", () => {
  test("should translate a simple text stream correctly", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: " there" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-1",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })

  test("should translate a stream with tool calls", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_xyz",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-2",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    // Streaming translation requires state
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    // These tests will fail until the stub is implemented
    for (const event of translatedStream) {
      expect(isValidAnthropicStreamEvent(event)).toBe(true)
    }
  })
})

describe("OpenAI stream interleaved tool/content translation", () => {
  test("should defer content while a tool call is still streaming", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_weather",
                  type: "function",
                  function: { name: "get_weather", arguments: "" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"loc' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: { content: "I will check that." },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ation": "Paris"}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-tool-content",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o-2024-05-13",
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls", logprobs: null },
        ],
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )

    const toolArgumentDeltaIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_delta"
        && event.index === 0
        && event.delta.type === "input_json_delta"
        && event.delta.partial_json === '{"location": "Paris"}',
    )
    const toolStopIndex = translatedStream.findIndex(
      (event) => event.type === "content_block_stop" && event.index === 0,
    )
    const deferredTextStartIndex = translatedStream.findIndex(
      (event) =>
        event.type === "content_block_start"
        && event.index === 1
        && event.content_block.type === "text",
    )

    expect(toolArgumentDeltaIndex).toBeGreaterThan(-1)
    expect(toolStopIndex).toBeGreaterThan(toolArgumentDeltaIndex)
    expect(deferredTextStartIndex).toBeGreaterThan(toolStopIndex)
    expect(translatedStream).toContainEqual({
      type: "content_block_delta",
      index: 1,
      delta: {
        type: "text_delta",
        text: "I will check that.",
      },
    })
  })
})

describe("OpenAI usage-only stream translation", () => {
  test("should emit final Anthropic usage from an OpenAI usage-only chunk", () => {
    const openAIStream: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [
          { index: 0, delta: {}, finish_reason: "stop", logprobs: null },
        ],
      },
      {
        id: "cmpl-usage",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "qwen-plus",
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: {
            cache_creation_input_tokens: 3,
            cached_tokens: 12,
          },
        },
      },
    ]

    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const translatedStream = openAIStream.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    translatedStream.push(...flushPendingAnthropicStreamEvents(streamState))

    const messageDeltaEvents = translatedStream.filter(
      (event) => event.type === "message_delta",
    )
    expect(messageDeltaEvents).toHaveLength(1)
    expect(messageDeltaEvents[0]).toEqual({
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 85,
        output_tokens: 20,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 12,
      },
    })
    expect(translatedStream.at(-1)).toEqual({ type: "message_stop" })
  })

  test("defers completion across metadata-only chunks until final usage", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const finishChunk: ChatCompletionChunk = {
      id: "cmpl-metadata",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "kimi-k3",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }
    const metadataChunk: ChatCompletionChunk = {
      ...finishChunk,
      choices: [],
    }
    const usageChunk: ChatCompletionChunk = {
      ...metadataChunk,
      usage: {
        prompt_tokens: 8_544,
        completion_tokens: 174,
        total_tokens: 8_718,
      },
    }

    translateChunkToAnthropicEvents(finishChunk, streamState)
    expect(translateChunkToAnthropicEvents(metadataChunk, streamState)).toEqual(
      [],
    )
    expect(translateChunkToAnthropicEvents(usageChunk, streamState)).toEqual([
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          input_tokens: 8_544,
          output_tokens: 174,
        },
      },
      { type: "message_stop" },
    ])
    expect(flushPendingAnthropicStreamEvents(streamState)).toEqual([])
  })

  test("flushes a metadata-delayed completion exactly once at EOF", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const finishChunk: ChatCompletionChunk = {
      id: "cmpl-metadata-eof",
      object: "chat.completion.chunk",
      created: 1677652288,
      model: "kimi-k3",
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    }

    translateChunkToAnthropicEvents(finishChunk, streamState)
    expect(
      translateChunkToAnthropicEvents(
        {
          ...finishChunk,
          choices: [],
        },
        streamState,
      ),
    ).toEqual([])
    expect(flushPendingAnthropicStreamEvents(streamState)).toEqual([
      {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
      { type: "message_stop" },
    ])
    expect(flushPendingAnthropicStreamEvents(streamState)).toEqual([])
  })

  test("should close a thinking-only block before finishing", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-thinking-only",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "Thinking" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-thinking-only",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "length",
            logprobs: null,
          },
        ],
      },
    ]

    const events = chunks.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    events.push(...flushPendingAnthropicStreamEvents(streamState))

    const thinkingStart = events.findIndex(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "thinking",
    )
    const thinkingStop = events.findIndex(
      (event) => event.type === "content_block_stop" && event.index === 0,
    )
    const messageDelta = events.findIndex(
      (event) => event.type === "message_delta",
    )

    expect(thinkingStart).toBeGreaterThan(-1)
    expect(thinkingStop).toBeGreaterThan(thinkingStart)
    expect(messageDelta).toBeGreaterThan(thinkingStop)
    expect(events.at(-1)).toEqual({ type: "message_stop" })
  })

  test("should buffer interleaved parallel tool arguments into valid blocks", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const toolChunks: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-interleaved-tools",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_alpha",
                  type: "function",
                  function: { name: "alpha", arguments: '{"value":"' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-interleaved-tools",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call_beta",
                  type: "function",
                  function: { name: "beta", arguments: '{"value":"' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-interleaved-tools",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'alpha"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-interleaved-tools",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 1, function: { arguments: 'beta"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-interleaved-tools",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      },
    ]

    const events = toolChunks.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    events.push(...flushPendingAnthropicStreamEvents(streamState))

    const starts = events.filter(
      (event) =>
        event.type === "content_block_start"
        && event.content_block.type === "tool_use",
    )
    expect(starts).toHaveLength(2)
    expect(
      starts.map((event) =>
        event.type === "content_block_start" && "name" in event.content_block ?
          event.content_block.name
        : null,
      ),
    ).toEqual(["alpha", "beta"])

    for (const index of [0, 1]) {
      const stopPosition = events.findIndex(
        (event) => event.type === "content_block_stop" && event.index === index,
      )
      const lateDelta = events.findIndex(
        (event, position) =>
          position > stopPosition
          && event.type === "content_block_delta"
          && event.index === index,
      )
      expect(stopPosition).toBeGreaterThan(-1)
      expect(lateDelta).toBe(-1)
    }

    const argumentsByIndex = new Map<number, string>()
    for (const event of events) {
      if (
        event.type === "content_block_delta"
        && event.delta.type === "input_json_delta"
      ) {
        argumentsByIndex.set(
          event.index,
          `${argumentsByIndex.get(event.index) ?? ""}${event.delta.partial_json}`,
        )
      }
    }
    expect(JSON.parse(argumentsByIndex.get(0) ?? "")).toEqual({
      value: "alpha",
    })
    expect(JSON.parse(argumentsByIndex.get(1) ?? "")).toEqual({
      value: "beta",
    })
  })

  test("should suppress streamed thinking when the client disables thinking", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      emitThinking: false,
    }
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-disabled-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "hidden reasoning" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-disabled-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            delta: { content: "OK" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-disabled-thinking",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gemini-3.5-flash",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      },
    ]

    const events = chunks.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    events.push(...flushPendingAnthropicStreamEvents(streamState))

    expect(
      events.some(
        (event) =>
          event.type === "content_block_start"
          && event.content_block.type === "thinking",
      ),
    ).toBe(false)
    expect(events).toContainEqual({
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: "OK",
      },
    })
  })

  test("should close an open text block before buffering tool calls", () => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    const chunks: Array<ChatCompletionChunk> = [
      {
        id: "cmpl-text-then-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "Before tool" },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-text-then-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_tool",
                  type: "function",
                  function: { name: "tool", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      },
      {
        id: "cmpl-text-then-tool",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "tool_calls",
            logprobs: null,
          },
        ],
      },
    ]

    const events = chunks.flatMap((chunk) =>
      translateChunkToAnthropicEvents(chunk, streamState),
    )
    const textStop = events.findIndex(
      (event) => event.type === "content_block_stop" && event.index === 0,
    )
    const toolStart = events.findIndex(
      (event) =>
        event.type === "content_block_start"
        && event.index === 1
        && event.content_block.type === "tool_use",
    )

    expect(textStop).toBeGreaterThan(-1)
    expect(toolStart).toBeGreaterThan(textStop)
  })
})
