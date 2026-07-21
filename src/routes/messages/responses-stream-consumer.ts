import type { ConsolaInstance } from "consola"

import type { ResolvedProviderConfig } from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import { observeCopilotResponsesMetadata } from "~/lib/copilot-rate-limit"
import { debugJsonTail, debugLazy } from "~/lib/logger"
import {
  getResponsesStreamSessionFailure,
  runResponsesStreamSession,
  type ResponsesStreamSessionFrame,
} from "~/lib/responses-stream-session"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import { type TokenUsageRecorder } from "~/lib/token-usage"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import type {
  ResponsesStream,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import {
  BufferedResponsesTerminalError,
  collectResponsesStreamResult,
  recordBufferedResponsesTerminalFailure,
} from "./responses-stream-collection"
import { createBufferedResponsesProtocolError } from "./responses-result"
import {
  createResponsesStreamState,
  type ResponsesStreamState,
  translateResponsesStreamEvent,
} from "./responses-stream-translation"
import {
  emitAnthropicStreamError,
  type AnthropicStreamOutput,
} from "./stream-error"

export type { AnthropicStreamOutput } from "./stream-error"

interface ResponsesStreamConsumerBase {
  logger: ConsolaInstance
  observeParsed?: (event: unknown) => void
  output: AnthropicStreamOutput
  payload: AnthropicMessagesPayload
  recordUsage: TokenUsageRecorder
  signal?: AbortSignal
  transport: StreamTransport
  upstreamResponse: ResponsesStream
}

type ResponsesStreamConsumerOptions =
  | (ResponsesStreamConsumerBase & {
      kind: "copilot"
    })
  | (ResponsesStreamConsumerBase & {
      kind: "provider"
      provider: string
      providerConfig: ResolvedProviderConfig
      releaseUpstream?: (reason: unknown) => Promise<void> | void
    })

export const consumeResponsesStream = async (
  options: ResponsesStreamConsumerOptions,
): Promise<void> => {
  if (options.kind === "copilot") {
    await consumeCopilotResponsesStream(options)
    return
  }
  await consumeProviderResponsesStream(options)
}

export const collectProviderResponsesStreamResult = async ({
  errorMessagePrefix,
  logger,
  providerConfig,
  recordUsage,
  upstreamResponse,
}: {
  errorMessagePrefix: string
  logger: ConsolaInstance
  providerConfig: ResolvedProviderConfig
  recordUsage: TokenUsageRecorder
  upstreamResponse: ResponsesStream
}) => {
  try {
    return await collectResponsesStreamResult({
      errorMessagePrefix,
      logger,
      onParsed: (event) => {
        if (providerConfig.name === "codex") {
          logCodexRateLimitsEvent(event)
        }
      },
      upstreamResponse,
    })
  } catch (error) {
    if (error instanceof BufferedResponsesTerminalError) {
      recordBufferedResponsesTerminalFailure(recordUsage, error)
      throw createBufferedResponsesProtocolError(error)
    }
    throw error
  }
}

const consumeCopilotResponsesStream = async (
  options: Extract<ResponsesStreamConsumerOptions, { kind: "copilot" }>,
): Promise<void> => {
  const { logger, payload } = options
  const streamState = createResponsesStreamState({
    emitThinking: payload.thinking?.type !== "disabled",
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  await consumeTranslatedResponsesStream({
    ...options,
    doneMarkerBehavior: "ignore",
    eofErrorMessage: "Responses stream ended without completion",
    flow: "responses",
    onData: (data) => {
      debugLazy(logger, () => ["Responses raw stream event:", data])
    },
    onTranslatedData: (eventData) => {
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
    },
    malformedBehavior: "error",
    onParsed: (event) => {
      observeCopilotResponsesMetadata(event)
      options.observeParsed?.(event)
    },
    streamState,
  })
}

const consumeProviderResponsesStream = async (
  options: Extract<ResponsesStreamConsumerOptions, { kind: "provider" }>,
): Promise<void> => {
  const { logger, payload, provider, providerConfig } = options
  const streamState = createResponsesStreamState({
    carrierSource: { model: payload.model, provider },
    emitThinking: payload.thinking?.type !== "disabled",
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  await consumeTranslatedResponsesStream({
    ...options,
    doneMarkerBehavior: "end",
    eofErrorMessage: `${provider} stream ended without a completion event`,
    flow: "provider_responses",
    onChunk: (chunk) => {
      debugJsonTail(logger, "provider.messages.responses.raw_stream_event:", {
        value: chunk.data,
        tailLength: 1_000,
      })
    },
    onTranslatedData: (eventData) => {
      debugLazy(logger, () => [
        "provider.messages.responses.translated_event:",
        eventData,
      ])
    },
    malformedBehavior: "ignore",
    onParsed: (event) => {
      if (providerConfig.name === "codex") logCodexRateLimitsEvent(event)
      options.observeParsed?.(event)
    },
    streamState,
  })
}

interface TranslatedResponsesStreamConsumerOptions
  extends ResponsesStreamConsumerBase {
  doneMarkerBehavior: "end" | "ignore"
  eofErrorMessage: string
  flow: "provider_responses" | "responses"
  malformedBehavior: "error" | "ignore"
  onChunk?: (chunk: { data?: string; event?: string }) => void
  onData?: (data: string) => void
  onParsed?: (event: unknown) => void
  onTranslatedData?: (data: string) => void
  releaseUpstream?: (reason: unknown) => Promise<void> | void
  streamState: ResponsesStreamState
}

const consumeTranslatedResponsesStream = async (
  options: TranslatedResponsesStreamConsumerOptions,
): Promise<void> => {
  const {
    doneMarkerBehavior,
    eofErrorMessage,
    flow,
    logger,
    malformedBehavior,
    onChunk,
    onData,
    onParsed,
    onTranslatedData,
    output,
    recordUsage,
    releaseUpstream,
    signal,
    streamState,
    transport,
    upstreamResponse,
  } = options
  const sourceWasUnopenedForAbort = signal?.aborted === true
  const adapterTerminal = new AbortController()
  const sessionSignal =
    signal ?
      AbortSignal.any([signal, adapterTerminal.signal])
    : adapterTerminal.signal
  const outcome = await runResponsesStreamSession({
    doneMarkerBehavior:
      doneMarkerBehavior === "ignore" ? "continue" : "terminate",
    onFrame: async (frame) => {
      onChunk?.(frame.wire)
      await deliverTranslatedResponsesFrame({
        frame,
        malformedBehavior,
        logger,
        onData,
        onParsed,
        onTranslatedData,
        output,
        streamState,
      })
      if (
        streamState.messageCompleted
        && frame.kind === "event"
        && !frame.terminal
      ) {
        adapterTerminal.abort(new Error("Anthropic translation completed"))
      }
    },
    signal: sessionSignal,
    source: upstreamResponse,
  })

  const failure = getResponsesStreamSessionFailure(outcome, eofErrorMessage)
  if (failure) {
    await emitAnthropicStreamError(output, logger, {
      diagnostics: {
        elapsedMs: outcome.diagnostics.elapsedMs,
        eventCount: outcome.diagnostics.frameCount,
        flow,
        lastEventType: outcome.diagnostics.lastEventType,
        retryCount: 0,
        terminalSeen: outcome.diagnostics.terminalSeen,
        transport,
      },
      error: failure.error,
      flow,
      signal,
    })
  }

  if (streamState.messageCompleted) {
    logger.debug("Responses message completed, ending stream", {
      flow,
      transport,
    })
  }
  await releaseResponsesUpstream({
    flow,
    logger,
    reason:
      sessionSignal.reason
      ?? failure?.error
      ?? new Error("Responses stream consumer finished"),
    releaseUpstream,
    transport,
  })
  if (sourceWasUnopenedForAbort) {
    await releaseUnopenedResponsesSource({
      flow,
      logger,
      source: upstreamResponse,
      transport,
    })
  }
  recordUsage(outcome.terminal?.usage ?? {})
}

const deliverTranslatedResponsesFrame = async ({
  frame,
  malformedBehavior,
  logger,
  onData,
  onParsed,
  onTranslatedData,
  output,
  streamState,
}: {
  frame: ResponsesStreamSessionFrame
  malformedBehavior: "error" | "ignore"
  logger: ConsolaInstance
  onData?: (data: string) => void
  onParsed?: (event: unknown) => void
  onTranslatedData?: (data: string) => void
  output: AnthropicStreamOutput
  streamState: ResponsesStreamState
}): Promise<void> => {
  if (frame.kind === "ping") {
    await output.writeSSE({ event: "ping", data: '{"type":"ping"}' })
    return
  }
  if (frame.kind === "malformed") {
    if (malformedBehavior === "error") {
      throw new Error("Responses stream contained a malformed event")
    }
    logger.error("provider.messages.responses.parse_chunk_error", {
      frameKind: frame.kind,
    })
    return
  }
  if (frame.kind === "unknown") {
    onParsed?.(frame.parsed)
    return
  }
  if (frame.kind !== "event") return

  onData?.(frame.wire.data ?? "")
  onParsed?.(frame.event)
  for (const event of translateResponsesStreamEvent(
    frame.event as unknown as ResponseStreamEvent,
    streamState,
  )) {
    const eventData = JSON.stringify(event)
    onTranslatedData?.(eventData)
    await output.writeSSE({
      event: event.type,
      data: eventData,
    })
  }
}

const releaseResponsesUpstream = async ({
  flow,
  logger,
  reason,
  releaseUpstream,
  transport,
}: {
  flow: "provider_responses" | "responses"
  logger: ConsolaInstance
  reason: unknown
  releaseUpstream?: (reason: unknown) => Promise<void> | void
  transport: StreamTransport
}): Promise<void> => {
  try {
    await releaseUpstream?.(reason)
  } catch {
    logger.debug("messages.responses.release_failed", {
      flow,
      stage: "transport",
      transport,
    })
  }
}

const releaseUnopenedResponsesSource = async ({
  flow,
  logger,
  source,
  transport,
}: {
  flow: "provider_responses" | "responses"
  logger: ConsolaInstance
  source: ResponsesStream
  transport: StreamTransport
}): Promise<void> => {
  try {
    await source[Symbol.asyncIterator]().return?.()
  } catch {
    logger.debug("messages.responses.release_failed", {
      flow,
      stage: "iterator",
      transport,
    })
  }
}
