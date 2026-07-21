import { expect, mock, test } from "bun:test"
import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import type { ResolvedProviderConfig } from "../src/lib/config"
import type {
  TokenUsageRecordMetadata,
  UsageTokens,
} from "../src/lib/token-usage"
import type { AnthropicMessagesPayload } from "../src/routes/messages/anthropic-types"
import {
  BufferedResponsesTerminalError,
  collectResponsesStreamResult,
} from "../src/routes/messages/responses-stream-collection"
import {
  consumeResponsesStream,
  type AnthropicStreamOutput,
} from "../src/routes/messages/responses-stream-consumer"
import { prefetchResponsesStreamSession } from "../src/routes/provider/responses/stream-prefetch"
import {
  recordResponsesStreamSessionUsage,
  relayResponsesStreamSession,
  type ResponsesSseMessage,
} from "../src/routes/responses/stream-session-adapter"
import type {
  ResponsesResult,
  ResponsesStream,
} from "../src/services/copilot/create-responses"

type ScenarioKind =
  | "abort"
  | "completed"
  | "eof"
  | "error"
  | "failed"
  | "incomplete"
  | "throw"

interface ConformanceScenario {
  kind: ScenarioKind
  usage: UsageTokens
}

interface HarnessRunContext {
  abortError: Error
  controller: AbortController
  observeMetadata: (value: unknown) => void
  scenario: ConformanceScenario
  source: ResponsesStream
  sourceError: Error
}

interface HarnessResult {
  kind: ScenarioKind
  usage: UsageTokens
  usageRecordCount: number
}

interface AdapterHarness {
  name: string
  ownsUsageRecorder: boolean
  run(context: HarnessRunContext): Promise<HarnessResult>
}

const EXPECTED_TERMINAL_USAGE: UsageTokens = {
  cache_creation_input_tokens: 2,
  cache_read_input_tokens: 3,
  input_tokens: 3,
  output_tokens: 2,
  total_nano_aiu: 77,
  total_tokens: 10,
}

const scenarios: Array<ConformanceScenario> = [
  { kind: "completed", usage: EXPECTED_TERMINAL_USAGE },
  { kind: "incomplete", usage: EXPECTED_TERMINAL_USAGE },
  { kind: "failed", usage: EXPECTED_TERMINAL_USAGE },
  { kind: "error", usage: EXPECTED_TERMINAL_USAGE },
  { kind: "eof", usage: {} },
  { kind: "throw", usage: {} },
  { kind: "abort", usage: {} },
]

const logger = {
  debug: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
} as unknown as ConsolaInstance

const harnesses: Array<AdapterHarness> = [
  {
    name: "native SSE relay",
    ownsUsageRecorder: true,
    run: async (context) => {
      const usage = createUsageCapture()
      const outcome = await relayResponsesStreamSession({
        eofErrorMessage: "matrix native EOF",
        flow: "responses",
        logger,
        observeFrame: (frame) => observeFrameMetadata(frame, context),
        output: createResponsesOutput(),
        recordUsage: usage.record,
        signal: context.controller.signal,
        source: context.source,
        transport: "http",
      })
      return {
        kind: outcome.kind as ScenarioKind,
        usage: usage.lastUsage(),
        usageRecordCount: usage.count(),
      }
    },
  },
  {
    name: "Responses to Anthropic",
    ownsUsageRecorder: true,
    run: async (context) => {
      const usage = createUsageCapture()
      const messages = new Array<{ data: string; event?: string }>()
      await consumeResponsesStream({
        kind: "provider",
        logger,
        observeParsed: context.observeMetadata,
        output: createAnthropicOutput(messages),
        payload: createAnthropicPayload(),
        provider: "example",
        providerConfig: createProviderConfig(),
        recordUsage: usage.record,
        signal: context.controller.signal,
        transport: "http",
        upstreamResponse: context.source,
      })
      return {
        kind: classifyAnthropicOutcome(messages, context),
        usage: usage.lastUsage(),
        usageRecordCount: usage.count(),
      }
    },
  },
  {
    name: "buffered collector",
    ownsUsageRecorder: false,
    run: async (context) => {
      try {
        const result = await collectResponsesStreamResult({
          logger,
          onParsed: context.observeMetadata,
          signal: context.controller.signal,
          upstreamResponse: context.source,
        })
        return {
          kind: result.status === "incomplete" ? "incomplete" : "completed",
          usage: readBufferedSuccessUsage(result),
          usageRecordCount: 0,
        }
      } catch (error) {
        if (error instanceof BufferedResponsesTerminalError) {
          return {
            kind:
              error.failure.terminal === "response.failed" ? "failed" : "error",
            usage: { ...error.failure.usage },
            usageRecordCount: 0,
          }
        }
        if (error === context.sourceError) {
          return { kind: "throw", usage: {}, usageRecordCount: 0 }
        }
        if (error === context.abortError) {
          return { kind: "abort", usage: {}, usageRecordCount: 0 }
        }
        if (
          error instanceof Error
          && error.message.includes("terminal event")
        ) {
          return { kind: "eof", usage: {}, usageRecordCount: 0 }
        }
        throw error
      }
    },
  },
  {
    name: "provider route prefetch",
    ownsUsageRecorder: true,
    run: async (context) => {
      const usage = createUsageCapture()
      const prefetched = await prefetchResponsesStreamSession({
        observeFrame: (frame) => observeFrameMetadata(frame, context),
        signal: context.controller.signal,
        source: context.source,
      })
      if (prefetched.kind === "settled") {
        recordResponsesStreamSessionUsage(usage.record, prefetched.outcome)
        return {
          kind: prefetched.outcome.kind as ScenarioKind,
          usage: usage.lastUsage(),
          usageRecordCount: usage.count(),
        }
      }

      try {
        const outcome = await relayResponsesStreamSession({
          eofErrorMessage: "matrix provider EOF",
          flow: "provider_responses",
          logger,
          observeFrame: (frame) => observeFrameMetadata(frame, context),
          output: createResponsesOutput(),
          recordUsage: usage.record,
          signal: context.controller.signal,
          source: prefetched.source,
          transport: "http",
        })
        return {
          kind: outcome.kind as ScenarioKind,
          usage: usage.lastUsage(),
          usageRecordCount: usage.count(),
        }
      } finally {
        await prefetched.cancel()
      }
    },
  },
]

for (const harness of harnesses) {
  for (const scenario of scenarios) {
    test(`${harness.name} shares conformance for ${scenario.kind}`, async () => {
      const controller = new AbortController()
      const sourceError = new Error("matrix source throw")
      const abortError = new Error("matrix caller abort")
      const inspected = createScenarioStream(scenario.kind, sourceError)
      let metadataCount = 0
      const observeMetadata = (value: unknown): void => {
        if (!isMetadataEvent(value)) return
        metadataCount += 1
        if (scenario.kind === "abort") controller.abort(abortError)
      }

      const result = await harness.run({
        abortError,
        controller,
        observeMetadata,
        scenario,
        source: inspected.stream,
        sourceError,
      })

      expect(result.kind).toBe(scenario.kind)
      expect(result.usage).toEqual(scenario.usage)
      expect(metadataCount).toBe(1)
      expect(inspected.readsPastTerminal()).toBe(0)
      expect(inspected.exhausted() || inspected.returnCount() > 0).toBe(true)
      if (scenario.kind !== "eof") expect(inspected.returnCount()).toBe(1)
      expect(result.usageRecordCount).toBe(harness.ownsUsageRecorder ? 1 : 0)
    })
  }
}

const observeFrameMetadata = (
  frame: {
    kind: string
    parsed?: unknown
    event?: unknown
  },
  context: HarnessRunContext,
): void => {
  if (frame.kind === "unknown") context.observeMetadata(frame.parsed)
  if (frame.kind === "event") context.observeMetadata(frame.event)
}

const createUsageCapture = (): {
  count: () => number
  lastUsage: () => UsageTokens
  record: (
    usage: UsageTokens,
    metadata?: TokenUsageRecordMetadata,
  ) => "accepted"
} => {
  const calls = new Array<{
    metadata: TokenUsageRecordMetadata | undefined
    usage: UsageTokens
  }>()
  return {
    count: () => calls.length,
    lastUsage: () => ({ ...(calls.at(-1)?.usage ?? {}) }),
    record: (usage, metadata) => {
      calls.push({ metadata, usage: { ...usage } })
      return "accepted"
    },
  }
}

const createScenarioStream = (
  kind: ScenarioKind,
  sourceError: Error,
): {
  exhausted: () => boolean
  readsPastTerminal: () => number
  returnCount: () => number
  stream: ResponsesStream
} => {
  const metadata = createMetadataChunk()
  const terminal = isTerminalScenario(kind) ? createTerminalChunk(kind) : null
  let exhausted = false
  let index = 0
  let readsPastTerminal = 0
  let returnCount = 0
  return {
    exhausted: () => exhausted,
    readsPastTerminal: () => readsPastTerminal,
    returnCount: () => returnCount,
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          index += 1
          if (terminal && index === 1) {
            return Promise.resolve({ done: false as const, value: terminal })
          }
          if (!terminal && index === 1) {
            return Promise.resolve({ done: false as const, value: metadata })
          }
          if (terminal || kind === "abort") {
            readsPastTerminal += 1
            return Promise.reject(new Error("matrix read past terminal"))
          }
          if (kind === "throw") return Promise.reject(sourceError)
          exhausted = true
          return Promise.resolve({ done: true as const, value: undefined })
        },
        return: () => {
          returnCount += 1
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }),
    },
  }
}

const createMetadataChunk = () => ({
  data: JSON.stringify({
    plan_type: "team",
    rate_limits: {},
    type: "codex.rate_limits",
  }),
  event: "codex.rate_limits",
})

const createTerminalChunk = (
  terminal: Exclude<ScenarioKind, "abort" | "eof" | "throw">,
) => {
  if (terminal === "error") {
    return {
      data: JSON.stringify({
        code: "upstream_error",
        copilot_usage: { total_nano_aiu: 77 },
        message: "matrix error terminal",
        sequence_number: 1,
        type: "error",
        usage: createRawUsage(),
      }),
      event: "error",
    }
  }
  return {
    data: JSON.stringify({
      copilot_usage: { total_nano_aiu: 77 },
      response: createResponsesResult(terminal),
      sequence_number: 1,
      type: `response.${terminal}`,
    }),
    event: `response.${terminal}`,
  }
}

const createResponsesResult = (
  terminal: "completed" | "failed" | "incomplete",
): ResponsesResult => ({
  created_at: 0,
  error:
    terminal === "failed" ?
      { code: "upstream_error", message: "matrix failed terminal" }
    : null,
  id: "resp-conformance",
  incomplete_details:
    terminal === "incomplete" ? { reason: "max_output_tokens" } : null,
  instructions: null,
  metadata: null,
  model: "gpt-test",
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: terminal,
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: createRawUsage(),
})

const createRawUsage = () => ({
  input_tokens: 8,
  input_tokens_details: {
    cached_tokens: 3,
    cache_write_tokens: 2,
  },
  output_tokens: 2,
  total_tokens: 10,
})

const readBufferedSuccessUsage = (result: ResponsesResult): UsageTokens => {
  const usage = result.usage
  expect(usage).not.toBeNull()
  expect(usage?.input_tokens).toBe(8)
  expect(usage?.input_tokens_details?.cached_tokens).toBe(3)
  expect(usage?.input_tokens_details?.cache_write_tokens).toBe(2)
  expect(usage?.output_tokens).toBe(2)
  expect(usage?.total_tokens).toBe(10)
  expect(result.copilot_usage?.total_nano_aiu).toBe(77)
  return { ...EXPECTED_TERMINAL_USAGE }
}

const classifyAnthropicOutcome = (
  messages: Array<{ data: string; event?: string }>,
  context: HarnessRunContext,
): ScenarioKind => {
  if (context.controller.signal.aborted) return "abort"
  const parsed = messages.flatMap((message) => {
    try {
      return [JSON.parse(message.data) as Record<string, unknown>]
    } catch {
      return []
    }
  })
  const errorMessage = parsed.find((event) => event.type === "error")?.error
  const serializedError = JSON.stringify(errorMessage ?? "")
  if (serializedError.includes("matrix failed terminal")) return "failed"
  if (serializedError.includes("matrix error terminal")) return "error"
  if (serializedError.includes(context.sourceError.message)) return "throw"
  if (serializedError.includes("ended without a completion event")) return "eof"

  const messageDelta = parsed.find((event) => event.type === "message_delta")
  const stopReason = (
    messageDelta?.delta as { stop_reason?: unknown } | undefined
  )?.stop_reason
  if (stopReason === "max_tokens") return "incomplete"
  if (stopReason === "end_turn") return "completed"
  throw new Error("Anthropic harness produced no classifiable outcome")
}

const createResponsesOutput = (): SSEStreamingApi =>
  ({
    writeSSE: (_message: ResponsesSseMessage) => Promise.resolve(),
  }) as unknown as SSEStreamingApi

const createAnthropicOutput = (
  messages: Array<{ data: string; event?: string }>,
): AnthropicStreamOutput => ({
  writeSSE: (message) => {
    messages.push(message)
    return Promise.resolve()
  },
})

const createAnthropicPayload = (): AnthropicMessagesPayload => ({
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

const isMetadataEvent = (value: unknown): boolean => {
  if (!value || typeof value !== "object") return false
  const event = value as Record<string, unknown>
  if (event.type === "codex.rate_limits") return true
  const copilotUsage = event.copilot_usage
  return (
    Boolean(copilotUsage)
    && typeof copilotUsage === "object"
    && (copilotUsage as Record<string, unknown>).total_nano_aiu === 77
  )
}

const isTerminalScenario = (
  kind: ScenarioKind,
): kind is "completed" | "error" | "failed" | "incomplete" =>
  kind === "completed"
  || kind === "error"
  || kind === "failed"
  || kind === "incomplete"
