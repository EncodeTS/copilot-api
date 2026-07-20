import { expect, mock, test } from "bun:test"
import type { ConsolaInstance } from "consola"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type { UsageTokens } from "../src/lib/token-usage"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import {
  consumeResponsesStream,
  type AnthropicStreamOutput,
} from "../src/routes/messages/responses-stream-consumer"
import type {
  ResponsesResult,
  ResponsesStream,
} from "../src/services/copilot/create-responses"

test("Copilot Responses consumer owns terminal, usage, and incremental output", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const response = createResponsesResult()
  response.usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    total_tokens: 16,
  }

  await consumeResponsesStream({
    kind: "copilot",
    logger,
    output,
    payload: createPayload(),
    recordUsage,
    transport: "websocket",
    upstreamResponse: createThrowingStream(
      [
        { event: "ping", data: "" },
        createResponseCreatedChunk(response),
        createResponseCompletedChunk(response, {
          copilot_usage: { total_nano_aiu: 3_000_000_000 },
        }),
      ],
      "read past terminal",
    ),
  })

  expect(messages.map(({ event }) => event)).toContain("ping")
  expect(messages.map(({ event }) => event)).toContain("message_start")
  expect(messages.map(({ event }) => event)).toContain("message_stop")
  expect(messages.map(({ event }) => event)).not.toContain("error")
  expect(recordUsage).toHaveBeenCalledWith({
    cache_read_input_tokens: 2,
    input_tokens: 10,
    output_tokens: 4,
    total_nano_aiu: 3_000_000_000,
    total_tokens: 16,
  })
})

test("Provider Responses consumer keeps parser, DONE, and usage semantics private", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const response = createResponsesResult()
  response.usage = {
    input_tokens: 12,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens: 4,
    total_tokens: 16,
  }

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    transport: "http",
    upstreamResponse: createStream([
      { event: "message", data: "not-json" },
      { event: "ping", data: "" },
      createResponseCreatedChunk(response),
      createResponseCompletedChunk(response),
      { event: "message", data: "[DONE]" },
    ]),
  })

  expect(logger.error).toHaveBeenCalledTimes(1)
  expect(messages.map(({ event }) => event)).toContain("ping")
  expect(messages.map(({ event }) => event)).toContain("message_start")
  expect(messages.map(({ event }) => event)).toContain("message_stop")
  expect(messages.map(({ event }) => event)).not.toContain("error")
  expect(recordUsage).toHaveBeenCalledWith({
    cache_read_input_tokens: 2,
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 16,
  })
})

test("Provider Responses consumer owns incomplete-stream error and recording", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const response = createResponsesResult()

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    transport: "http",
    upstreamResponse: createStream([
      createResponseCreatedChunk(response),
      createOutputTextDeltaChunk(),
    ]),
  })

  expect(messages.map(({ event }) => event)).toContain("content_block_delta")
  expect(messages.filter(({ event }) => event === "error")).toHaveLength(1)
  expect(messages.at(-1)?.data).toContain(
    "example stream ended without a completion event",
  )
  expect(recordUsage).toHaveBeenCalledWith({})
})

test("Provider Responses consumer turns a partial source failure into one Anthropic error", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const response = createResponsesResult()

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    transport: "http",
    upstreamResponse: createThrowingStream(
      [createResponseCreatedChunk(response), createOutputTextDeltaChunk()],
      "provider socket reset",
    ),
  })

  expect(messages.map(({ event }) => event)).toContain("message_start")
  expect(messages.map(({ event }) => event)).toContain("content_block_delta")
  expect(messages.filter(({ event }) => event === "error")).toHaveLength(1)
  expect(messages.at(-1)?.data).toContain("provider socket reset")
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage).toHaveBeenCalledWith({})
})

test("Provider Responses consumer stops pulling after a typed terminal", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const response = createResponsesResult()
  response.usage = {
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
  }

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    transport: "http",
    upstreamResponse: createThrowingStream(
      [
        createResponseCreatedChunk(response),
        createResponseCompletedChunk(response),
      ],
      "read past provider terminal",
    ),
  })

  expect(messages.filter(({ event }) => event === "message_stop")).toHaveLength(
    1,
  )
  expect(messages.map(({ event }) => event)).not.toContain("error")
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage).toHaveBeenCalledWith({
    cache_read_input_tokens: 0,
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
  })
})

test("Provider Responses consumer releases an already-aborted source without fabricating an error", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const controller = new AbortController()
  controller.abort(new Error("client disconnected before stream read"))
  const source = createInspectableStream([
    createResponseCreatedChunk(createResponsesResult()),
  ])

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    signal: controller.signal,
    transport: "http",
    upstreamResponse: source.stream,
  })

  expect(messages).toEqual([])
  expect(source.nextCount()).toBe(0)
  expect(source.returnCount()).toBe(1)
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage).toHaveBeenCalledWith({})
})

test("Provider Responses consumer releases the source when the caller aborts after partial output", async () => {
  const logger = createLogger()
  const messages: Array<{ data: string; event?: string }> = []
  const recordUsage = mock((_usage: UsageTokens) => {})
  const controller = new AbortController()
  const response = createResponsesResult()
  const source = createInspectableStream([
    createResponseCreatedChunk(response),
    createOutputTextDeltaChunk(),
  ])

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output: {
      writeSSE: (message) => {
        messages.push(message)
        if (message.event === "content_block_delta") {
          controller.abort(
            new Error("client disconnected after partial output"),
          )
        }
        return Promise.resolve()
      },
    },
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    signal: controller.signal,
    transport: "websocket",
    upstreamResponse: source.stream,
  })

  expect(messages.map(({ event }) => event)).toContain("message_start")
  expect(messages.map(({ event }) => event)).toContain("content_block_delta")
  expect(messages.map(({ event }) => event)).not.toContain("error")
  expect(messages.map(({ event }) => event)).not.toContain("message_stop")
  expect(source.nextCount()).toBe(2)
  expect(source.returnCount()).toBe(1)
  expect(recordUsage).toHaveBeenCalledTimes(1)
  expect(recordUsage).toHaveBeenCalledWith({})
})

test("Provider Responses consumer keeps release diagnostics content-safe", async () => {
  const logger = createLogger()
  const { messages, output } = createOutput()
  const recordUsage = mock((_usage: UsageTokens) => {})
  const controller = new AbortController()
  controller.abort(new Error("client disconnected"))
  const source = createInspectableStream([], {
    returnError: new Error("private prompt and bearer token"),
  })

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    releaseUpstream: () =>
      Promise.reject(new Error("private upstream cleanup detail")),
    signal: controller.signal,
    transport: "websocket",
    upstreamResponse: source.stream,
  })

  expect(messages).toEqual([])
  expect(source.returnCount()).toBe(1)
  expect(logger.debug).toHaveBeenCalledTimes(2)
  expect(logger.debug).toHaveBeenNthCalledWith(
    1,
    "messages.responses.release_failed",
    {
      flow: "provider_responses",
      stage: "transport",
      transport: "websocket",
    },
  )
  expect(logger.debug).toHaveBeenNthCalledWith(
    2,
    "messages.responses.release_failed",
    {
      flow: "provider_responses",
      stage: "iterator",
      transport: "websocket",
    },
  )
  expect(
    JSON.stringify(
      (
        logger.debug as unknown as {
          mock: { calls: Array<Array<unknown>> }
        }
      ).mock.calls,
    ),
  ).not.toContain("private prompt")
  expect(
    JSON.stringify(
      (
        logger.debug as unknown as {
          mock: { calls: Array<Array<unknown>> }
        }
      ).mock.calls,
    ),
  ).not.toContain("private upstream")
  expect(recordUsage).toHaveBeenCalledTimes(1)
})

const createLogger = (): ConsolaInstance =>
  ({
    debug: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
  }) as unknown as ConsolaInstance

const createOutput = (): {
  messages: Array<{ data: string; event?: string }>
  output: AnthropicStreamOutput
} => {
  const messages: Array<{ data: string; event?: string }> = []
  return {
    messages,
    output: {
      writeSSE: (message) => {
        messages.push(message)
        return Promise.resolve()
      },
    },
  }
}

const createPayload = (): AnthropicMessagesPayload => ({
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  model: "gpt-test",
  stream: true,
})

const createProviderConfig = (): ResolvedProviderConfig => ({
  apiKey: "test-key",
  authType: "authorization",
  baseUrl: "https://provider.example",
  name: "example",
  type: "openai-responses",
})

const createResponsesResult = (): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "resp-test",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: null,
})

const createResponseCreatedChunk = (
  response: ResponsesResult,
): { data: string; event: string } => ({
  event: "response.created",
  data: JSON.stringify({
    response,
    sequence_number: 0,
    type: "response.created",
  }),
})

const createOutputTextDeltaChunk = (): { data: string; event: string } => ({
  event: "response.output_text.delta",
  data: JSON.stringify({
    content_index: 0,
    delta: "partial",
    item_id: "msg-test",
    output_index: 0,
    sequence_number: 1,
    type: "response.output_text.delta",
  }),
})

const createResponseCompletedChunk = (
  response: ResponsesResult,
  extra: Record<string, unknown> = {},
): { data: string; event: string } => ({
  event: "response.completed",
  data: JSON.stringify({
    ...extra,
    response,
    sequence_number: 1,
    type: "response.completed",
  }),
})

async function* createStream(
  events: Array<{ data?: string; event?: string }>,
): ResponsesStream {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
}

async function* createThrowingStream(
  events: Array<{ data?: string; event?: string }>,
  message: string,
): ResponsesStream {
  for (const event of events) {
    await Promise.resolve()
    yield event
  }
  throw new Error(message)
}

const createInspectableStream = (
  events: Array<{ data?: string; event?: string }>,
  options: { returnError?: Error } = {},
): {
  nextCount: () => number
  returnCount: () => number
  stream: ResponsesStream
} => {
  let nextCount = 0
  let returnCount = 0
  const iterator: AsyncIterator<{ data?: string; event?: string }> = {
    next: () => {
      const index = nextCount
      nextCount += 1
      const event = events[index]
      if (!event) {
        return Promise.reject(new Error("source read after expected boundary"))
      }
      return Promise.resolve({ done: false, value: event })
    },
    return: () => {
      returnCount += 1
      if (options.returnError) {
        return Promise.reject(options.returnError)
      }
      return Promise.resolve({ done: true, value: undefined })
    },
  }

  return {
    nextCount: () => nextCount,
    returnCount: () => returnCount,
    stream: {
      [Symbol.asyncIterator]: () => iterator,
    },
  }
}
