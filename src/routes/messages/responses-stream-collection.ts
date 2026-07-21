import type { ConsolaInstance } from "consola"

import { observeCopilotResponsesMetadata } from "~/lib/copilot-rate-limit"

import type {
  ResponsesStreamEvent as ProtocolResponsesStreamEvent,
  ResponsesStreamTerminalEvent,
  ResponsesStreamTerminalEventType,
} from "~/lib/responses-stream-protocol"
import {
  runResponsesStreamSession,
  type ResponsesStreamSessionOutcome,
} from "~/lib/responses-stream-session"
import {
  TOKEN_USAGE_ERROR_CODE_VALUES,
  type TokenUsageErrorCode,
  type TokenUsageRecordResult,
  type TokenUsageRecorder,
  type UsageTokens,
} from "~/lib/token-usage"
import type {
  CopilotUsage,
  ResponseStreamEvent,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"

export type BufferedResponsesFailureTerminal = Extract<
  ResponsesStreamTerminalEventType,
  "error" | "response.failed"
>

export interface BufferedResponsesTerminalFailure {
  readonly errorCode: TokenUsageErrorCode
  readonly message: string
  readonly terminal: BufferedResponsesFailureTerminal
  readonly usage: Readonly<UsageTokens>
}

export class BufferedResponsesTerminalError extends Error {
  readonly failure: BufferedResponsesTerminalFailure

  constructor(failure: BufferedResponsesTerminalFailure) {
    super(failure.message)
    this.name = "BufferedResponsesTerminalError"
    this.failure = Object.freeze({
      ...failure,
      usage: Object.freeze({ ...failure.usage }),
    })
  }
}

export const recordBufferedResponsesTerminalFailure = (
  recordUsage: TokenUsageRecorder,
  error: BufferedResponsesTerminalError,
): TokenUsageRecordResult =>
  recordUsage(error.failure.usage, {
    errorCode: error.failure.errorCode,
    outcome: "failed",
    terminal: error.failure.terminal,
  })

interface ResponsesStreamCollection {
  outputItemsByIndex: Map<number, ResponsesResult["output"][number]>
}

export const collectResponsesStreamResult = async ({
  errorMessagePrefix = "Responses stream",
  onEvent,
  onParsed,
  signal,
  upstreamResponse,
  logger,
}: {
  errorMessagePrefix?: string
  onEvent?: (event: ResponseStreamEvent) => void
  onParsed?: (event: unknown) => void
  signal?: AbortSignal
  upstreamResponse: ResponsesStream
  logger: ConsolaInstance
}): Promise<ResponsesResult> => {
  const state = createResponsesStreamCollection()
  const outcome = await runResponsesStreamSession({
    doneMarkerBehavior: "continue",
    onFrame: (frame) => {
      logger.debug("messages.responses.buffered_frame", {
        eventType: frame.kind === "event" ? frame.event.type : null,
        frameKind: frame.kind,
        terminal:
          frame.kind === "event" ? (frame.terminal?.kind ?? null) : null,
      })
      if (frame.kind === "unknown") {
        observeCopilotResponsesMetadata(frame.parsed)
        onParsed?.(frame.parsed)
        return
      }
      if (frame.kind !== "event") return
      observeCopilotResponsesMetadata(frame.event)
      onParsed?.(frame.event)
      onEvent?.(frame.event as unknown as ResponseStreamEvent)
      collectResponsesStreamEvent(frame.event, state)
    },
    signal,
    source: upstreamResponse,
  })

  return resolveResponsesStreamCollectionOutcome(
    outcome,
    state,
    errorMessagePrefix,
  )
}

const createResponsesStreamCollection = (): ResponsesStreamCollection => ({
  outputItemsByIndex: new Map(),
})

const collectResponsesStreamEvent = (
  event: ProtocolResponsesStreamEvent,
  state: ResponsesStreamCollection,
): void => {
  if (event.type !== "response.output_item.done") return
  const outputIndex = event.output_index
  if (!Number.isSafeInteger(outputIndex) || Number(outputIndex) < 0) return
  const item = event.item
  if (typeof item !== "object" || item === null || Array.isArray(item)) return
  state.outputItemsByIndex.set(
    Number(outputIndex),
    item as ResponsesResult["output"][number],
  )
}

const resolveResponsesStreamCollectionOutcome = (
  outcome: ResponsesStreamSessionOutcome,
  state: ResponsesStreamCollection,
  errorMessagePrefix: string,
): ResponsesResult => {
  switch (outcome.kind) {
    case "completed":
    case "incomplete":
      return materializeResponsesResult(outcome.terminal.event, state)
    case "error":
    case "failed":
      throw createBufferedResponsesTerminalError(
        outcome.terminal.event,
        outcome.terminal.usage,
      )
    case "abort":
      throw asError(outcome.reason, `${errorMessagePrefix} aborted`)
    case "delivery_failed":
      throw asError(
        outcome.deliveryError,
        `${errorMessagePrefix} collection failed`,
      )
    case "eof":
      throw new Error(`${errorMessagePrefix} ended without a terminal event`)
    case "throw":
      throw asError(outcome.error, `${errorMessagePrefix} failed`)
    case "timeout":
      throw outcome.error
  }
}

const materializeResponsesResult = (
  event: Extract<
    ResponsesStreamTerminalEvent,
    { type: "response.completed" | "response.incomplete" }
  >,
  state: ResponsesStreamCollection,
): ResponsesResult => {
  const response = event.response as unknown as ResponsesResult
  const lastCollectedIndex = Math.max(-1, ...state.outputItemsByIndex.keys())
  const outputLength = Math.max(response.output.length, lastCollectedIndex + 1)
  const output = new Array<ResponsesResult["output"][number]>()
  for (let index = 0; index < outputLength; index += 1) {
    const item = state.outputItemsByIndex.get(index) ?? response.output[index]
    if (item === undefined) {
      throw new Error(
        `Responses terminal output is missing output_index ${index}`,
      )
    }
    output.push(item)
  }
  return {
    ...response,
    copilot_usage:
      response.copilot_usage ?? (event.copilot_usage as CopilotUsage),
    output,
  }
}

const TOKEN_USAGE_ERROR_CODE_SET = new Set<string>(
  TOKEN_USAGE_ERROR_CODE_VALUES,
)

const UPSTREAM_ERROR_CODE_ALIASES: Readonly<
  Record<string, TokenUsageErrorCode>
> = Object.freeze({
  rate_limit_exceeded: "rate_limited",
  server_error: "upstream_error",
  temporarily_unavailable: "overloaded",
})

const createBufferedResponsesTerminalError = (
  event: Extract<
    ResponsesStreamTerminalEvent,
    { type: "error" | "response.failed" }
  >,
  usage: Readonly<UsageTokens>,
): BufferedResponsesTerminalError => {
  const terminal = event.type
  const rawCode =
    terminal === "error" ?
      (event.error?.code ?? event.code)
    : event.response.error?.code
  return new BufferedResponsesTerminalError({
    errorCode: normalizeBufferedResponsesErrorCode(rawCode, terminal),
    message: "Responses upstream reported an error",
    terminal,
    usage,
  })
}

const normalizeBufferedResponsesErrorCode = (
  value: unknown,
  terminal: BufferedResponsesFailureTerminal,
): TokenUsageErrorCode => {
  if (typeof value === "string") {
    if (TOKEN_USAGE_ERROR_CODE_SET.has(value)) {
      return value as TokenUsageErrorCode
    }
    const alias = UPSTREAM_ERROR_CODE_ALIASES[value]
    if (alias) return alias
  }
  return terminal === "response.failed" ? "response_failed" : "upstream_error"
}

const asError = (value: unknown, fallbackMessage: string): Error =>
  value instanceof Error ? value : new Error(fallbackMessage)
