import type {
  AnthropicStreamEventData,
  AnthropicUsage,
} from "../../src/routes/messages/anthropic-types"
import type {
  CopilotUsage,
  ResponseCompletedEvent,
  ResponseFailedEvent,
  ResponseIncompleteEvent,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseUsage,
} from "../../src/services/copilot/create-responses"

export type ResponsesTerminalEvent =
  | ResponseCompletedEvent
  | ResponseFailedEvent
  | ResponseIncompleteEvent

export interface ProtocolStreamOptions {
  errorAfter?: Error
}

export interface SseFixtureMessage {
  data: string
  event: string
}

export const createResponsesUsage = (
  overrides: Partial<ResponseUsage> = {},
): ResponseUsage => ({
  input_tokens: 12,
  input_tokens_details: {
    cached_tokens: 2,
    cache_write_tokens: 1,
  },
  output_tokens: 4,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 16,
  ...overrides,
})

export const createResponsesResult = (
  overrides: Partial<ResponsesResult> = {},
): ResponsesResult => ({
  created_at: 0,
  error: null,
  id: "fixture-response",
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: "fixture-model",
  object: "response",
  output: [],
  output_text: "",
  parallel_tool_calls: false,
  status: "completed",
  temperature: null,
  tool_choice: "auto",
  tools: [],
  top_p: null,
  usage: createResponsesUsage(),
  ...overrides,
})

export const createResponsesTerminalEvent = (
  type: ResponsesTerminalEvent["type"] = "response.completed",
  {
    copilotUsage,
    response,
    sequenceNumber = 1,
  }: {
    copilotUsage?: CopilotUsage | null
    response?: Partial<ResponsesResult>
    sequenceNumber?: number
  } = {},
): ResponsesTerminalEvent => {
  const baseResponse = createResponsesResult(response)
  const shared = {
    ...(copilotUsage === undefined ? {} : { copilot_usage: copilotUsage }),
    sequence_number: sequenceNumber,
  }

  switch (type) {
    case "response.completed": {
      return {
        ...shared,
        response: {
          ...baseResponse,
          error: null,
          incomplete_details: null,
          status: "completed",
        },
        type,
      }
    }
    case "response.failed": {
      return {
        ...shared,
        response: {
          ...baseResponse,
          error: response?.error ?? {
            code: "fixture_error",
            message: "fixture failure",
          },
          incomplete_details: null,
          status: "failed",
        },
        type,
      }
    }
    case "response.incomplete": {
      return {
        ...shared,
        response: {
          ...baseResponse,
          error: null,
          incomplete_details: response?.incomplete_details ?? {
            reason: "max_output_tokens",
          },
          status: "incomplete",
        },
        type,
      }
    }
  }
}

export const createAnthropicUsage = (
  overrides: Partial<AnthropicUsage> = {},
): AnthropicUsage => ({
  cache_creation_input_tokens: 1,
  cache_read_input_tokens: 2,
  input_tokens: 9,
  output_tokens: 4,
  ...overrides,
})

export const createAnthropicTerminalEvents = ({
  stopReason = "end_turn",
  stopSequence = null,
  usage = createAnthropicUsage(),
}: {
  stopReason?:
    | "end_turn"
    | "max_tokens"
    | "pause_turn"
    | "refusal"
    | "stop_sequence"
    | "tool_use"
  stopSequence?: string | null
  usage?: AnthropicUsage
} = {}): Array<AnthropicStreamEventData> => [
  {
    delta: { stop_reason: stopReason, stop_sequence: stopSequence },
    type: "message_delta",
    usage,
  },
  { type: "message_stop" },
]

export const createResponsesSseStream = (
  events: ReadonlyArray<ResponseStreamEvent>,
  options?: ProtocolStreamOptions,
): AsyncGenerator<SseFixtureMessage> => createSseStream(events, options)

export const createAnthropicSseStream = (
  events: ReadonlyArray<AnthropicStreamEventData>,
  options?: ProtocolStreamOptions,
): AsyncGenerator<SseFixtureMessage> => createSseStream(events, options)

async function* createSseStream<T extends { type: string }>(
  events: ReadonlyArray<T>,
  { errorAfter }: ProtocolStreamOptions = {},
): AsyncGenerator<SseFixtureMessage> {
  for (const event of events) {
    await Promise.resolve()
    yield { data: JSON.stringify(event), event: event.type }
  }
  if (errorAfter) throw errorAfter
}
