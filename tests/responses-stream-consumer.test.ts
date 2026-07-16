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
        {
          event: "response.created",
          data: JSON.stringify({
            response,
            sequence_number: 0,
            type: "response.created",
          }),
        },
        {
          event: "response.completed",
          data: JSON.stringify({
            copilot_usage: { total_nano_aiu: 3_000_000_000 },
            response,
            sequence_number: 1,
            type: "response.completed",
          }),
        },
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
    upstreamResponse: createStream([
      { event: "message", data: "not-json" },
      { event: "ping", data: "" },
      {
        event: "response.created",
        data: JSON.stringify({
          response,
          sequence_number: 0,
          type: "response.created",
        }),
      },
      {
        event: "response.completed",
        data: JSON.stringify({
          response,
          sequence_number: 1,
          type: "response.completed",
        }),
      },
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

  await consumeResponsesStream({
    kind: "provider",
    logger,
    output,
    payload: createPayload(),
    provider: "example",
    providerConfig: createProviderConfig(),
    recordUsage,
    upstreamResponse: createStream([]),
  })

  expect(messages).toHaveLength(1)
  expect(messages[0]?.event).toBe("error")
  expect(messages[0]?.data).toContain(
    "example stream ended without a completion event",
  )
  expect(recordUsage).toHaveBeenCalledWith({})
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
