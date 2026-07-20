import type { ConsolaInstance } from "consola"

import type { ResolvedProviderConfig } from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import { debugJsonTail, debugLazy } from "~/lib/logger"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import {
  normalizeOptionalToken,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import type {
  ResponsesStream,
  ResponseStreamEvent,
} from "~/services/copilot/create-responses"

import type { AnthropicMessagesPayload } from "./anthropic-types"
import { collectResponsesStreamResult } from "./responses-stream-collection"
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
  output: AnthropicStreamOutput
  payload: AnthropicMessagesPayload
  recordUsage: (usage: UsageTokens) => void
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
  upstreamResponse,
}: {
  errorMessagePrefix: string
  logger: ConsolaInstance
  providerConfig: ResolvedProviderConfig
  upstreamResponse: ResponsesStream
}) =>
  await collectResponsesStreamResult({
    errorMessagePrefix,
    logger,
    parseEvent: (data) =>
      parseProviderResponsesStreamEvent(data, providerConfig, logger),
    upstreamResponse,
  })

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
    normalizeTerminalUsage: (event) => ({
      ...normalizeResponsesUsage(event.response.usage),
      total_nano_aiu: normalizeOptionalToken(
        event.copilot_usage?.total_nano_aiu,
      ),
    }),
    onData: (data) => {
      debugLazy(logger, () => ["Responses raw stream event:", data])
    },
    onTranslatedData: (eventData) => {
      debugLazy(logger, () => ["Translated Anthropic event:", eventData])
    },
    parseEvent: (data) => JSON.parse(data) as ResponseStreamEvent,
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
    normalizeTerminalUsage: (event) =>
      normalizeResponsesUsage(event.response.usage),
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
    parseEvent: (data) =>
      parseProviderResponsesStreamEvent(data, providerConfig, logger),
    streamState,
  })
}

type TerminalResponsesEvent = Extract<
  ResponseStreamEvent,
  {
    type: "response.completed" | "response.failed" | "response.incomplete"
  }
>

interface TranslatedResponsesStreamConsumerOptions
  extends ResponsesStreamConsumerBase {
  doneMarkerBehavior: "end" | "ignore"
  eofErrorMessage: string
  flow: "provider_responses" | "responses"
  normalizeTerminalUsage: (event: TerminalResponsesEvent) => UsageTokens
  onChunk?: (chunk: { data?: string; event?: string }) => void
  onData?: (data: string) => void
  onTranslatedData?: (data: string) => void
  parseEvent: (data: string) => ResponseStreamEvent | null
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
    normalizeTerminalUsage,
    onChunk,
    onData,
    onTranslatedData,
    output,
    parseEvent,
    recordUsage,
    releaseUpstream,
    signal,
    streamState,
    transport,
    upstreamResponse,
  } = options
  const streamStartedAt = Date.now()
  let usage: UsageTokens = {}
  let eventCount = 0
  let lastEventType: string | null = null
  let iteratorExhausted = false
  let cleanupReason: unknown = new Error("Responses stream consumer finished")
  const iterator = upstreamResponse[Symbol.asyncIterator]()

  try {
    while (!signal?.aborted) {
      const result = await iterator.next()
      if (result.done) {
        iteratorExhausted = true
        break
      }
      if (signal?.aborted) break

      const chunk = result.value
      onChunk?.(chunk)
      if (chunk.event === "ping") {
        await output.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        eventCount += 1
        lastEventType = "ping"
        continue
      }
      const data = chunk.data
      if (!data) continue
      if (data === "[DONE]") {
        if (doneMarkerBehavior === "end") break
        continue
      }

      onData?.(data)
      const responseEvent = parseEvent(data)
      if (!responseEvent) continue
      lastEventType = responseEvent.type
      if (isTerminalResponsesEvent(responseEvent)) {
        usage = normalizeTerminalUsage(responseEvent)
      }

      for (const event of translateResponsesStreamEvent(
        responseEvent,
        streamState,
      )) {
        const eventData = JSON.stringify(event)
        onTranslatedData?.(eventData)
        await output.writeSSE({
          event: event.type,
          data: eventData,
        })
        eventCount += 1
      }

      if (streamState.messageCompleted) {
        logger.debug("Responses message completed, ending stream", {
          flow,
          transport,
        })
        break
      }
    }

    if (!streamState.messageCompleted && !signal?.aborted) {
      const error = new Error(eofErrorMessage)
      cleanupReason = error
      await emitAnthropicStreamError(output, logger, {
        diagnostics: {
          elapsedMs: Date.now() - streamStartedAt,
          eventCount,
          flow,
          lastEventType,
          retryCount: 0,
          terminalSeen: false,
          transport,
        },
        error,
        flow,
        signal,
      })
    }
  } catch (error) {
    cleanupReason = error
    await emitAnthropicStreamError(output, logger, {
      diagnostics: {
        elapsedMs: Date.now() - streamStartedAt,
        eventCount,
        flow,
        lastEventType,
        retryCount: 0,
        terminalSeen: streamState.messageCompleted,
        transport,
      },
      error,
      flow,
      signal,
    })
  } finally {
    await releaseResponsesStreamSource({
      flow,
      iterator,
      iteratorExhausted,
      logger,
      reason: signal?.reason ?? cleanupReason,
      releaseUpstream,
      transport,
    })
    recordUsage(usage)
  }
}

const releaseResponsesStreamSource = async ({
  flow,
  iterator,
  iteratorExhausted,
  logger,
  reason,
  releaseUpstream,
  transport,
}: {
  flow: "provider_responses" | "responses"
  iterator: AsyncIterator<{ data?: string; event?: string }>
  iteratorExhausted: boolean
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

  if (iteratorExhausted) return

  try {
    await iterator.return?.()
  } catch {
    logger.debug("messages.responses.release_failed", {
      flow,
      stage: "iterator",
      transport,
    })
  }
}

const parseProviderResponsesStreamEvent = (
  data: string,
  providerConfig: ResolvedProviderConfig,
  logger: ConsolaInstance,
): ResponseStreamEvent | null => {
  try {
    const parsed = JSON.parse(data) as ResponseStreamEvent
    if (providerConfig.name === "codex") {
      logCodexRateLimitsEvent(parsed)
    }
    return parsed
  } catch (error) {
    logger.error("provider.messages.responses.parse_chunk_error", {
      provider: providerConfig.name,
      data,
      error,
    })
    return null
  }
}

const isTerminalResponsesEvent = (
  event: ResponseStreamEvent,
): event is TerminalResponsesEvent =>
  event.type === "response.completed"
  || event.type === "response.failed"
  || event.type === "response.incomplete"
