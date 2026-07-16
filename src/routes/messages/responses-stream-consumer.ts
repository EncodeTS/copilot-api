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
  buildErrorEvent,
  createResponsesStreamState,
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
  upstreamResponse: ResponsesStream
}

type ResponsesStreamConsumerOptions =
  | (ResponsesStreamConsumerBase & {
      kind: "copilot"
      signal?: AbortSignal
      transport: StreamTransport
    })
  | (ResponsesStreamConsumerBase & {
      kind: "provider"
      provider: string
      providerConfig: ResolvedProviderConfig
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
  const {
    logger,
    output,
    payload,
    recordUsage,
    signal,
    transport,
    upstreamResponse,
  } = options
  const streamState = createResponsesStreamState({
    emitThinking: payload.thinking?.type !== "disabled",
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  const streamStartedAt = Date.now()
  let usage: UsageTokens = {}
  let eventCount = 0
  let lastEventType: string | null = null

  try {
    for await (const chunk of upstreamResponse) {
      const eventName = chunk.event
      if (eventName === "ping") {
        await output.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        eventCount += 1
        lastEventType = "ping"
        continue
      }

      const data = chunk.data
      if (!data || data === "[DONE]") continue

      debugLazy(logger, () => ["Responses raw stream event:", data])
      const responseEvent = JSON.parse(data) as ResponseStreamEvent
      lastEventType = responseEvent.type
      if (isTerminalResponsesEvent(responseEvent)) {
        usage = {
          ...normalizeResponsesUsage(responseEvent.response.usage),
          total_nano_aiu: normalizeOptionalToken(
            responseEvent.copilot_usage?.total_nano_aiu,
          ),
        }
      }

      for (const event of translateResponsesStreamEvent(
        responseEvent,
        streamState,
      )) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => ["Translated Anthropic event:", eventData])
        await output.writeSSE({
          event: event.type,
          data: eventData,
        })
        eventCount += 1
      }

      if (streamState.messageCompleted) {
        logger.debug("Message completed, ending stream")
        break
      }
    }
  } catch (error) {
    await emitAnthropicStreamError(output, logger, {
      diagnostics: {
        elapsedMs: Date.now() - streamStartedAt,
        eventCount,
        flow: "responses",
        lastEventType,
        retryCount: 0,
        terminalSeen: streamState.messageCompleted,
        transport,
      },
      error,
      flow: "responses",
      signal,
    })
    recordUsage(usage)
    return
  }

  if (!streamState.messageCompleted && !signal?.aborted) {
    await emitAnthropicStreamError(output, logger, {
      diagnostics: {
        elapsedMs: Date.now() - streamStartedAt,
        eventCount,
        flow: "responses",
        lastEventType,
        retryCount: 0,
        terminalSeen: false,
        transport,
      },
      error: new Error("Responses stream ended without completion"),
      flow: "responses",
      signal,
    })
  }

  recordUsage(usage)
}

const consumeProviderResponsesStream = async (
  options: Extract<ResponsesStreamConsumerOptions, { kind: "provider" }>,
): Promise<void> => {
  const {
    logger,
    output,
    payload,
    provider,
    providerConfig,
    recordUsage,
    upstreamResponse,
  } = options
  let usage: UsageTokens = {}
  const streamState = createResponsesStreamState({
    carrierSource: { model: payload.model, provider },
    emitThinking: payload.thinking?.type !== "disabled",
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })

  try {
    for await (const chunk of upstreamResponse) {
      debugJsonTail(logger, "provider.messages.responses.raw_stream_event:", {
        value: chunk.data,
        tailLength: 1_000,
      })
      if (chunk.event === "ping") {
        await output.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }
      if (chunk.data === "[DONE]") break
      if (!chunk.data) continue

      const parsed = parseProviderResponsesStreamEvent(
        chunk.data,
        providerConfig,
        logger,
      )
      if (!parsed) continue
      if (isTerminalResponsesEvent(parsed)) {
        usage = normalizeResponsesUsage(parsed.response.usage)
      }

      for (const event of translateResponsesStreamEvent(parsed, streamState)) {
        const eventData = JSON.stringify(event)
        debugLazy(logger, () => [
          "provider.messages.responses.translated_event:",
          eventData,
        ])
        await output.writeSSE({
          event: event.type,
          data: eventData,
        })
      }
    }

    if (!streamState.messageCompleted) {
      const errorEvent = buildErrorEvent(
        `${provider} stream ended without a completion event`,
      )
      await output.writeSSE({
        event: errorEvent.type,
        data: JSON.stringify(errorEvent),
      })
    }
  } finally {
    recordUsage(usage)
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
): event is Extract<
  ResponseStreamEvent,
  {
    type: "response.completed" | "response.failed" | "response.incomplete"
  }
> =>
  event.type === "response.completed"
  || event.type === "response.failed"
  || event.type === "response.incomplete"
