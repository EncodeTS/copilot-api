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
  normalizeResponsesErrorCode,
  resolveResponsesStreamSessionUsageRecord,
  type ResponsesStreamSessionUsageRecord,
} from "~/lib/responses-stream-usage"
import {
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

type BufferedResponsesTerminalInterruptionKind =
  | "abort"
  | "delivery_failed"
  | "timeout"

const BUFFERED_RESPONSES_SURFACED_ERROR_MESSAGE: Readonly<
  Record<BufferedResponsesTerminalInterruptionKind, string>
> = Object.freeze({
  abort: "Responses stream aborted after terminal event",
  delivery_failed: "Responses stream delivery failed after terminal event",
  timeout: "Responses stream timed out after terminal event",
})

export class BufferedResponsesTerminalInterruptionError extends Error {
  readonly record: ResponsesStreamSessionUsageRecord
  readonly surfacedError: Error

  constructor(
    record: ResponsesStreamSessionUsageRecord,
    interruption: BufferedResponsesTerminalInterruptionKind,
  ) {
    super("Responses stream interrupted after a terminal event")
    this.name = "BufferedResponsesTerminalInterruptionError"
    this.record = Object.freeze({
      metadata: Object.freeze({ ...record.metadata }),
      usage: Object.freeze({ ...record.usage }),
    })
    this.surfacedError = new Error(
      BUFFERED_RESPONSES_SURFACED_ERROR_MESSAGE[interruption],
    )
  }
}

export interface BufferedResponsesCollectionLimits {
  readonly maxOutputIndex: number
  readonly maxOutputItemBytes: number
  readonly maxOutputItems: number
  readonly maxTotalOutputItemBytes: number
}

// Responses normally emits only a handful of output items. Leave generous room
// for tool arguments while bounding retained state and sparse materialization.
export const DEFAULT_BUFFERED_RESPONSES_COLLECTION_LIMITS: Readonly<BufferedResponsesCollectionLimits> =
  Object.freeze({
    maxOutputIndex: 4_095,
    maxOutputItemBytes: 8 * 1024 * 1024,
    maxOutputItems: 1_024,
    maxTotalOutputItemBytes: 32 * 1024 * 1024,
  })

export type BufferedResponsesCollectionLimitViolation =
  | "output-index"
  | "output-item-bytes"
  | "output-item-count"
  | "total-output-item-bytes"

export class BufferedResponsesCollectionLimitError extends Error {
  readonly limit: number
  readonly observed: number
  declare readonly record?: ResponsesStreamSessionUsageRecord
  readonly violation: BufferedResponsesCollectionLimitViolation

  constructor({
    limit,
    observed,
    record,
    violation,
  }: {
    limit: number
    observed: number
    record?: ResponsesStreamSessionUsageRecord
    violation: BufferedResponsesCollectionLimitViolation
  }) {
    super("Responses stream output collection exceeded its limit")
    this.name = "BufferedResponsesCollectionLimitError"
    this.limit = limit
    this.observed = observed
    if (record) {
      this.record = Object.freeze({
        metadata: Object.freeze({ ...record.metadata }),
        usage: Object.freeze({ ...record.usage }),
      })
    }
    this.violation = violation
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

export const recordBufferedResponsesTerminalInterruption = (
  recordUsage: TokenUsageRecorder,
  error: BufferedResponsesTerminalInterruptionError,
): TokenUsageRecordResult =>
  recordUsage(error.record.usage, error.record.metadata)

interface ResponsesStreamCollection {
  limits: Readonly<BufferedResponsesCollectionLimits>
  outputItemBytesByIndex: Map<number, number>
  outputItemsByIndex: Map<number, ResponsesResult["output"][number]>
  totalOutputItemBytes: number
}

export const collectResponsesStreamResult = async ({
  collectionLimits = DEFAULT_BUFFERED_RESPONSES_COLLECTION_LIMITS,
  errorMessagePrefix = "Responses stream",
  onEvent,
  onParsed,
  signal,
  upstreamResponse,
  logger,
}: {
  collectionLimits?: Readonly<BufferedResponsesCollectionLimits>
  errorMessagePrefix?: string
  onEvent?: (event: ResponseStreamEvent) => void
  onParsed?: (event: unknown) => void
  signal?: AbortSignal
  upstreamResponse: ResponsesStream
  logger: ConsolaInstance
}): Promise<ResponsesResult> => {
  const state = createResponsesStreamCollection(collectionLimits)
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

const createResponsesStreamCollection = (
  limits: Readonly<BufferedResponsesCollectionLimits>,
): ResponsesStreamCollection => ({
  limits,
  outputItemBytesByIndex: new Map(),
  outputItemsByIndex: new Map(),
  totalOutputItemBytes: 0,
})

const collectResponsesStreamEvent = (
  event: ProtocolResponsesStreamEvent,
  state: ResponsesStreamCollection,
): void => {
  if (event.type !== "response.output_item.done") return
  const outputIndex = event.output_index
  if (!Number.isSafeInteger(outputIndex) || Number(outputIndex) < 0) return
  const normalizedOutputIndex = Number(outputIndex)
  if (normalizedOutputIndex > state.limits.maxOutputIndex) {
    throw new BufferedResponsesCollectionLimitError({
      limit: state.limits.maxOutputIndex,
      observed: normalizedOutputIndex,
      violation: "output-index",
    })
  }
  const item = event.item
  if (typeof item !== "object" || item === null || Array.isArray(item)) return
  if (
    !state.outputItemsByIndex.has(normalizedOutputIndex)
    && state.outputItemsByIndex.size + 1 > state.limits.maxOutputItems
  ) {
    throw new BufferedResponsesCollectionLimitError({
      limit: state.limits.maxOutputItems,
      observed: state.outputItemsByIndex.size + 1,
      violation: "output-item-count",
    })
  }
  const outputItemBytes = Buffer.byteLength(JSON.stringify(item), "utf8")
  if (outputItemBytes > state.limits.maxOutputItemBytes) {
    throw new BufferedResponsesCollectionLimitError({
      limit: state.limits.maxOutputItemBytes,
      observed: outputItemBytes,
      violation: "output-item-bytes",
    })
  }
  const previousOutputItemBytes =
    state.outputItemBytesByIndex.get(normalizedOutputIndex) ?? 0
  const nextTotalOutputItemBytes =
    state.totalOutputItemBytes - previousOutputItemBytes + outputItemBytes
  if (nextTotalOutputItemBytes > state.limits.maxTotalOutputItemBytes) {
    throw new BufferedResponsesCollectionLimitError({
      limit: state.limits.maxTotalOutputItemBytes,
      observed: nextTotalOutputItemBytes,
      violation: "total-output-item-bytes",
    })
  }
  state.outputItemBytesByIndex.set(normalizedOutputIndex, outputItemBytes)
  state.outputItemsByIndex.set(
    normalizedOutputIndex,
    item as ResponsesResult["output"][number],
  )
  state.totalOutputItemBytes = nextTotalOutputItemBytes
}

const resolveResponsesStreamCollectionOutcome = (
  outcome: ResponsesStreamSessionOutcome,
  state: ResponsesStreamCollection,
  errorMessagePrefix: string,
): ResponsesResult => {
  switch (outcome.kind) {
    case "completed":
    case "incomplete":
      return materializeResponsesResult(outcome, state)
    case "error":
    case "failed":
      throw createBufferedResponsesTerminalError(
        outcome.terminal.event,
        outcome.terminal.usage,
      )
    case "abort":
      if (outcome.terminal) {
        throw new BufferedResponsesTerminalInterruptionError(
          resolveResponsesStreamSessionUsageRecord(outcome),
          "abort",
        )
      }
      throw asError(outcome.reason, `${errorMessagePrefix} aborted`)
    case "delivery_failed":
      if (outcome.terminal) {
        throw new BufferedResponsesTerminalInterruptionError(
          resolveResponsesStreamSessionUsageRecord(outcome),
          "delivery_failed",
        )
      }
      throw asError(
        outcome.deliveryError,
        `${errorMessagePrefix} collection failed`,
      )
    case "eof":
      throw new Error(`${errorMessagePrefix} ended without a terminal event`)
    case "throw":
      throw asError(outcome.error, `${errorMessagePrefix} failed`)
    case "timeout":
      if (outcome.terminal) {
        throw new BufferedResponsesTerminalInterruptionError(
          resolveResponsesStreamSessionUsageRecord(outcome),
          "timeout",
        )
      }
      throw outcome.error
  }
}

const materializeResponsesResult = (
  outcome: Extract<
    ResponsesStreamSessionOutcome,
    { kind: "completed" | "incomplete" }
  >,
  state: ResponsesStreamCollection,
): ResponsesResult => {
  const event = outcome.terminal.event
  const response = event.response as unknown as ResponsesResult
  const lastCollectedIndex = Math.max(-1, ...state.outputItemsByIndex.keys())
  const outputLength = Math.max(response.output.length, lastCollectedIndex + 1)
  if (outputLength > state.limits.maxOutputItems) {
    throw createTerminalCollectionLimitError(outcome, {
      limit: state.limits.maxOutputItems,
      observed: outputLength,
      violation: "output-item-count",
    })
  }
  const lastOutputIndex = outputLength - 1
  if (lastOutputIndex > state.limits.maxOutputIndex) {
    throw createTerminalCollectionLimitError(outcome, {
      limit: state.limits.maxOutputIndex,
      observed: lastOutputIndex,
      violation: "output-index",
    })
  }
  let totalOutputItemBytes = 0
  for (let index = 0; index < outputLength; index += 1) {
    const item = state.outputItemsByIndex.get(index) ?? response.output[index]
    if (item === undefined) {
      throw new Error(
        `Responses terminal output is missing output_index ${index}`,
      )
    }
    const itemBytes =
      state.outputItemBytesByIndex.get(index)
      ?? Buffer.byteLength(JSON.stringify(item), "utf8")
    if (itemBytes > state.limits.maxOutputItemBytes) {
      throw createTerminalCollectionLimitError(outcome, {
        limit: state.limits.maxOutputItemBytes,
        observed: itemBytes,
        violation: "output-item-bytes",
      })
    }
    totalOutputItemBytes += itemBytes
    if (totalOutputItemBytes > state.limits.maxTotalOutputItemBytes) {
      throw createTerminalCollectionLimitError(outcome, {
        limit: state.limits.maxTotalOutputItemBytes,
        observed: totalOutputItemBytes,
        violation: "total-output-item-bytes",
      })
    }
  }
  const output = new Array<ResponsesResult["output"][number]>(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    output[index] =
      state.outputItemsByIndex.get(index) ?? response.output[index]
  }
  return {
    ...response,
    copilot_usage:
      response.copilot_usage ?? (event.copilot_usage as CopilotUsage),
    output,
  }
}

const createTerminalCollectionLimitError = (
  outcome: Extract<
    ResponsesStreamSessionOutcome,
    { kind: "completed" | "incomplete" }
  >,
  details: {
    limit: number
    observed: number
    violation: BufferedResponsesCollectionLimitViolation
  },
): BufferedResponsesCollectionLimitError =>
  new BufferedResponsesCollectionLimitError({
    ...details,
    record: resolveResponsesStreamSessionUsageRecord(outcome, {
      failureOrigin: "local_materialization_error",
    }),
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
    errorCode: normalizeResponsesErrorCode(
      rawCode,
      terminal === "response.failed" ? "response_failed" : "upstream_error",
    ),
    message: "Responses upstream reported an error",
    terminal,
    usage,
  })
}

const asError = (value: unknown, fallbackMessage: string): Error =>
  value instanceof Error ? value : new Error(fallbackMessage)
