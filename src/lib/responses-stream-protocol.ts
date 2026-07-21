export const RESPONSES_STREAM_EVENT_TYPES = {
  error: true,
  "response.completed": true,
  "response.content_part.added": true,
  "response.content_part.done": true,
  "response.created": true,
  "response.failed": true,
  "response.function_call_arguments.delta": true,
  "response.function_call_arguments.done": true,
  "response.in_progress": true,
  "response.incomplete": true,
  "response.output_item.added": true,
  "response.output_item.done": true,
  "response.output_text.annotation.added": true,
  "response.output_text.delta": true,
  "response.output_text.done": true,
  "response.reasoning_summary_part.added": true,
  "response.reasoning_summary_part.done": true,
  "response.reasoning_summary_text.delta": true,
  "response.reasoning_summary_text.done": true,
  "response.refusal.delta": true,
  "response.refusal.done": true,
  "response.web_search_call.completed": true,
  "response.web_search_call.in_progress": true,
  "response.web_search_call.searching": true,
} as const

export type ResponsesStreamEventType = keyof typeof RESPONSES_STREAM_EVENT_TYPES

export type ResponsesStreamTerminalKind =
  | "completed"
  | "error"
  | "failed"
  | "incomplete"

interface ResponsesStreamEventBase {
  readonly sequence_number: number
  readonly type: ResponsesStreamEventType
  readonly [key: string]: unknown
}

export interface ResponsesStreamTerminalResponse {
  readonly copilot_usage?: unknown
  readonly error?: ResponsesStreamResponseError | null
  readonly incomplete_details?: ResponsesStreamIncompleteDetails | null
  readonly usage?: unknown
  readonly [key: string]: unknown
}

export interface ResponsesStreamResponseError {
  readonly code?: string | null
  readonly message: string
  readonly [key: string]: unknown
}

export interface ResponsesStreamIncompleteDetails {
  readonly reason?: string
  readonly [key: string]: unknown
}

export interface ResponsesStreamErrorDetails {
  readonly code?: string | null
  readonly message: string
  readonly [key: string]: unknown
}

interface ResponsesStreamResponseTerminalEvent
  extends ResponsesStreamEventBase {
  readonly copilot_usage?: unknown
  readonly response: ResponsesStreamTerminalResponse
  readonly type:
    | "response.completed"
    | "response.failed"
    | "response.incomplete"
}

export interface ResponsesStreamCompletedEvent
  extends ResponsesStreamResponseTerminalEvent {
  readonly type: "response.completed"
}

export interface ResponsesStreamFailedEvent
  extends ResponsesStreamResponseTerminalEvent {
  readonly type: "response.failed"
}

export interface ResponsesStreamIncompleteEvent
  extends ResponsesStreamResponseTerminalEvent {
  readonly type: "response.incomplete"
}

export interface ResponsesStreamErrorEvent extends ResponsesStreamEventBase {
  readonly code?: string | null
  readonly copilot_usage?: unknown
  readonly error?: ResponsesStreamErrorDetails | null
  readonly message: string
  readonly type: "error"
  readonly usage?: unknown
}

export type ResponsesStreamTerminalEvent =
  | ResponsesStreamCompletedEvent
  | ResponsesStreamErrorEvent
  | ResponsesStreamFailedEvent
  | ResponsesStreamIncompleteEvent

export type ResponsesStreamTerminalEventType =
  ResponsesStreamTerminalEvent["type"]

export const RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE = {
  error: "error",
  "response.completed": "completed",
  "response.failed": "failed",
  "response.incomplete": "incomplete",
} as const satisfies Record<
  ResponsesStreamTerminalEventType,
  ResponsesStreamTerminalKind
>

export type ResponsesStreamNonTerminalEventType = Exclude<
  ResponsesStreamEventType,
  ResponsesStreamTerminalEventType
>

export interface ResponsesStreamNonTerminalEvent
  extends ResponsesStreamEventBase {
  readonly type: ResponsesStreamNonTerminalEventType
}

export type ResponsesStreamEvent =
  | ResponsesStreamNonTerminalEvent
  | ResponsesStreamTerminalEvent

export type ResponsesStreamTerminalClassification = Readonly<{
  event: ResponsesStreamTerminalEvent
  kind: ResponsesStreamTerminalKind
}>

export type ResponsesStreamParseResult =
  | { readonly kind: "event"; readonly event: ResponsesStreamEvent }
  | { readonly kind: "malformed"; readonly parsed?: unknown }
  | { readonly kind: "unknown"; readonly parsed: unknown }

export const parseResponsesStreamEventData = (
  data: string,
): ResponsesStreamParseResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return { kind: "malformed" }
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") {
    return { kind: "malformed", parsed }
  }
  if (!isResponsesStreamEventType(parsed.type)) {
    return { kind: "unknown", parsed }
  }
  if (!isSequenceNumber(parsed.sequence_number)) {
    return { kind: "malformed", parsed }
  }

  const { sequence_number: sequenceNumber, type } = parsed
  switch (type) {
    case "response.completed":
    case "response.failed":
    case "response.incomplete":
      if (!isRecord(parsed.response)) {
        return { kind: "malformed", parsed }
      }
      if (!isOptionalResponseError(parsed.response.error)) {
        return { kind: "malformed", parsed }
      }
      if (!isOptionalIncompleteDetails(parsed.response.incomplete_details)) {
        return { kind: "malformed", parsed }
      }
      return {
        event: {
          ...parsed,
          response: {
            ...parsed.response,
            error: parsed.response.error,
            incomplete_details: parsed.response.incomplete_details,
          },
          sequence_number: sequenceNumber,
          type,
        },
        kind: "event",
      }
    case "error":
      if (typeof parsed.message !== "string") {
        return { kind: "malformed", parsed }
      }
      if (!isOptionalErrorDetails(parsed.error)) {
        return { kind: "malformed", parsed }
      }
      return {
        event: {
          ...parsed,
          error: parsed.error,
          message: parsed.message,
          sequence_number: sequenceNumber,
          type,
        },
        kind: "event",
      }
    default:
      return {
        event: {
          ...parsed,
          sequence_number: sequenceNumber,
          type,
        },
        kind: "event",
      }
  }
}

export const classifyResponsesStreamTerminalEvent = (
  event: ResponsesStreamEvent,
): ResponsesStreamTerminalClassification | null =>
  isResponsesStreamTerminalEvent(event) ?
    {
      event,
      kind: RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE[event.type],
    }
  : null

export const isResponsesStreamTerminalData = (data: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(data)
    return (
      isRecord(parsed)
      && typeof parsed.type === "string"
      && Object.hasOwn(RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE, parsed.type)
    )
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOptionalResponseError = (
  value: unknown,
): value is ResponsesStreamResponseError | null | undefined =>
  value === undefined
  || value === null
  || (isRecord(value)
    && typeof value.message === "string"
    && isOptionalString(value.code))

const isOptionalIncompleteDetails = (
  value: unknown,
): value is ResponsesStreamIncompleteDetails | null | undefined =>
  value === undefined
  || value === null
  || (isRecord(value)
    && (value.reason === undefined || typeof value.reason === "string"))

const isOptionalErrorDetails = (
  value: unknown,
): value is ResponsesStreamErrorDetails | null | undefined =>
  value === undefined
  || value === null
  || (isRecord(value)
    && typeof value.message === "string"
    && isOptionalString(value.code))

const isOptionalString = (value: unknown): value is string | null | undefined =>
  value === undefined || value === null || typeof value === "string"

const isResponsesStreamEventType = (
  value: string,
): value is ResponsesStreamEventType =>
  Object.hasOwn(RESPONSES_STREAM_EVENT_TYPES, value)

const isResponsesStreamTerminalEvent = (
  event: ResponsesStreamEvent,
): event is ResponsesStreamTerminalEvent =>
  Object.hasOwn(RESPONSES_STREAM_TERMINAL_KIND_BY_TYPE, event.type)

const isSequenceNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)
