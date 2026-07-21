import type { ConsolaInstance } from "consola"
import type { SSEStreamingApi } from "hono/streaming"

import type { StreamTransport } from "~/lib/stream-lifecycle"
import {
  getResponsesStreamSessionFailure,
  runResponsesStreamSession,
  type ResponsesStreamSessionFrame,
  type ResponsesStreamSessionOutcome,
} from "~/lib/responses-stream-session"
import type {
  TokenUsageRecordResult,
  TokenUsageRecorder,
} from "~/lib/token-usage"

import { emitResponsesStreamError } from "./stream-error"

export interface ResponsesSseMessage {
  data: string
  event?: string
  id?: string
  retry?: number
}

export interface RelayResponsesStreamSessionOptions {
  doneMarkerBehavior?: "continue" | "terminate"
  eofErrorMessage: string
  flow: "provider_responses" | "responses"
  logger: ConsolaInstance
  observeFrame?: (frame: ResponsesStreamSessionFrame) => void
  output: SSEStreamingApi
  projectFrame?: (
    frame: ResponsesStreamSessionFrame,
  ) => ResponsesSseMessage | null
  recordUsage: TokenUsageRecorder
  signal?: AbortSignal
  source: AsyncIterable<{
    comment?: string
    data?: string
    event?: string
    id?: number | string
    retry?: number
  }>
  transport: StreamTransport
}

export const relayResponsesStreamSession = async (
  options: RelayResponsesStreamSessionOptions,
): Promise<ResponsesStreamSessionOutcome> => {
  const outcome = await runResponsesStreamSession({
    doneMarkerBehavior: options.doneMarkerBehavior,
    onFrame: async (frame) => {
      options.observeFrame?.(frame)
      const message =
        options.projectFrame ?
          options.projectFrame(frame)
        : projectResponsesSessionFrame(frame)
      if (message) await options.output.writeSSE(message)
    },
    signal: options.signal,
    source: options.source,
  })

  const failure = getResponsesStreamSessionFailure(
    outcome,
    options.eofErrorMessage,
  )
  if (failure) {
    await emitResponsesStreamSessionFailure({
      error: failure.error,
      flow: options.flow,
      logger: options.logger,
      outcome,
      output: options.output,
      signal: options.signal,
      transport: options.transport,
    })
  }

  recordResponsesStreamSessionUsage(options.recordUsage, outcome)
  return outcome
}

export const emitResponsesStreamSessionFailure = async ({
  error,
  flow,
  logger,
  outcome,
  output,
  signal,
  transport,
}: {
  error: unknown
  flow: "provider_responses" | "responses"
  logger: ConsolaInstance
  outcome: ResponsesStreamSessionOutcome
  output: SSEStreamingApi
  signal?: AbortSignal
  transport: StreamTransport
}): Promise<void> => {
  await emitResponsesStreamError(output, logger, error, {
    diagnostics: {
      elapsedMs: outcome.diagnostics.elapsedMs,
      eventCount: outcome.diagnostics.frameCount,
      flow,
      lastEventType: outcome.diagnostics.lastEventType,
      retryCount: 0,
      terminalSeen: outcome.diagnostics.terminalSeen,
      transport,
    },
    signal,
  })
}

export const recordResponsesStreamSessionUsage = (
  recordUsage: TokenUsageRecorder,
  outcome: ResponsesStreamSessionOutcome,
): TokenUsageRecordResult => {
  if (outcome.kind === "error" || outcome.kind === "failed") {
    return recordUsage(outcome.terminal.usage, {
      outcome: "failed",
      terminal: outcome.terminal.event.type,
    })
  }
  return recordUsage(outcome.terminal?.usage ?? {})
}

export const projectResponsesSessionFrame = (
  frame: ResponsesStreamSessionFrame,
): ResponsesSseMessage | null => {
  const { wire } = frame
  return {
    data: wire.data ?? "",
    event: wire.event,
    id: wire.id === undefined ? undefined : String(wire.id),
    retry: wire.retry,
  }
}
