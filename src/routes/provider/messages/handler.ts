import type { Context, Env } from "hono"

import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
} from "~/routes/messages/anthropic-types"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import type {
  ResponsesResult,
  ResponseStreamEvent,
  ResponsesStream,
} from "~/services/copilot/create-responses"

import {
  type ModelConfig,
  type ResolvedProviderConfig,
  resolveEffectiveProviderType,
  resolveProviderAuthType,
} from "~/lib/config"
import { logCodexRateLimitsEvent } from "~/lib/codex-rate-limit"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import { createHandlerLogger, debugJson, debugLazy } from "~/lib/logger"
import { resolveProviderConfig } from "~/lib/provider-resolver"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  createProviderTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type UsageTokens,
} from "~/lib/token-usage"
import { parseUserIdMetadata } from "~/lib/utils"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "~/routes/messages/non-stream-translation"
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from "~/routes/messages/stream-translation"
import {
  buildErrorEvent,
  createResponsesStreamState,
  translateResponsesStreamEvent,
} from "~/routes/messages/responses-stream-translation"
import { collectResponsesStreamResult } from "~/routes/messages/responses-stream-collection"
import {
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  buildSyntheticStreamEvents,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  stripWebSearchServerTool,
} from "~/routes/messages/web-search/fulfill"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import { getModels as getCodexModels } from "~/services/codex/get-models"
import { forwardCodexResponses } from "~/services/codex/create-responses"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-messages-handler")

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderMessagesForProvider(c, { payload, provider })
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  const { payload, provider } = options
  const providerConfig = await resolveProviderConfig(provider)
  if (!providerConfig) {
    return c.json(
      {
        error: {
          message: `Provider '${provider}' not found or disabled`,
          type: "invalid_request_error",
        },
      },
      404,
    )
  }

  try {
    const modelConfig = providerConfig.models?.[payload.model]
    const effectiveType = resolveEffectiveProviderType(
      providerConfig,
      payload.model,
    )
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)

    applyModelDefaults(payload, modelConfig)

    if (effectiveType === "openai-responses") {
      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            modelConfig,
            payload,
            provider,
            providerConfig,
          })
        }

        stripWebSearchServerTool(payload)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
      })
    }

    if (effectiveType === "openai-compatible") {
      stripWebSearchServerTool(payload)

      return await handleOpenAICompatibleProviderMessages(c, {
        modelConfig,
        payload,
        provider,
        providerConfig,
      })
    }

    applyMissingExtraBody(payload as unknown as Record<string, unknown>, {
      extraBody: modelConfig?.extraBody,
    })

    debugJson(logger, "Translated provider.messages.request", {
      payload,
      provider,
    })
    const upstreamResponse = await forwardProviderMessages(
      effectiveType === providerConfig.type ?
        providerConfig
      : {
          ...providerConfig,
          type: effectiveType,
          authType: resolveProviderAuthType(
            providerConfig.name,
            undefined,
            effectiveType,
          ),
        },
      payload,
      c.req.raw.headers,
    )

    if (!upstreamResponse.ok) {
      logger.error("Failed to create responses", upstreamResponse)
      throw new HTTPError("Failed to create responses", upstreamResponse)
    }

    const contentType = upstreamResponse.headers.get("content-type") ?? ""
    const isStreamingResponse =
      Boolean(payload.stream) && contentType.includes("text/event-stream")

    if (isStreamingResponse) {
      return streamProviderMessages({
        c,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        upstreamResponse,
      })
    }

    const jsonBody = (await upstreamResponse.json()) as AnthropicResponse
    return respondProviderMessagesJson(c, {
      body: jsonBody,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
    })
  } catch (error) {
    logger.error("provider.messages.error", {
      provider,
      error,
    })
    throw error
  }
}

const handleOpenAIResponsesProviderWebSearchMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig } = options
  const responsesPayload = prepareWebSearchResponsesPayload(payload)

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (isResponsesStream(upstreamResponse)) {
      const body = await collectResponsesStreamResult({
        errorMessagePrefix: `${provider} web search responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondWebSearchProviderMessagesJson(c, {
        body,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
      })
    }

    return respondWebSearchProviderMessagesJson(c, {
      body: upstreamResponse,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider web search responses", {
      provider,
      upstreamResponse,
    })
    throw new HTTPError(
      "Failed to create provider web search responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  if (contentType.includes("text/event-stream")) {
    const body = await collectResponsesStreamResult({
      errorMessagePrefix: `${provider} web search responses stream`,
      parseEvent: (data) =>
        parseResponsesProviderStreamChunk(data, providerConfig),
      upstreamResponse: events(upstreamResponse),
      logger,
    })
    return respondWebSearchProviderMessagesJson(c, {
      body,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondWebSearchProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
  })
}

const handleOpenAIResponsesProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig } = options
  const selectedModel =
    providerConfig.name === "codex" ?
      getCodexModels().data.find((model) => model.id === payload.model)
    : undefined
  const wantsStream = payload.stream === true
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(payload)

  if (providerConfig.name === "codex" && !wantsStream) {
    responsesPayload.stream = true
  }

  const shouldCompactInput = applyResponsesApiContextManagement(
    responsesPayload,
    selectedModel?.capabilities.limits.max_prompt_tokens,
    {
      source: "messages",
    },
  )
  if (shouldCompactInput) {
    compactInputByLatestCompaction(responsesPayload)
  }

  debugJson(logger, "provider.messages.responses.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
    )

    if (isResponsesStream(upstreamResponse)) {
      if (wantsStream) {
        return streamResponsesProviderMessages({
          c,
          modelConfig,
          payload,
          pricingCurrency: providerConfig.pricingCurrency,
          provider,
          providerConfig,
          upstreamResponse,
        })
      }

      const body = await collectResponsesStreamResult({
        errorMessagePrefix: `${provider} messages responses stream`,
        parseEvent: (data) =>
          parseResponsesProviderStreamChunk(data, providerConfig),
        upstreamResponse,
        logger,
      })
      return respondResponsesProviderMessagesJson(c, {
        body,
        modelConfig,
        payload,
        pricingCurrency: providerConfig.pricingCurrency,
        provider,
        providerConfig,
      })
    }

    return respondResponsesProviderMessagesJson(c, {
      body: upstreamResponse,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      providerConfig,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider responses", upstreamResponse)
    throw new HTTPError("Failed to create provider responses", upstreamResponse)
  }

  if (responsesPayload.stream) {
    return streamResponsesProviderMessages({
      c,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      providerConfig,
      upstreamResponse: events(upstreamResponse),
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondResponsesProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
    providerConfig,
  })
}

const applyModelDefaults = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
): void => {
  payload.temperature ??= modelConfig?.temperature
  payload.top_p ??= modelConfig?.topP
  payload.top_k ??= modelConfig?.topK
}

const applyMissingExtraBody = (
  payload: Record<string, unknown>,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  for (const [key, value] of Object.entries(options.extraBody ?? {})) {
    if (!Object.hasOwn(payload, key)) {
      payload[key] = value
    }
  }
}

const getRequestThinkingBudget = (
  payload: AnthropicMessagesPayload,
): number | undefined => {
  const budget = payload.thinking?.budget_tokens
  if (typeof budget !== "number" || !Number.isFinite(budget)) {
    return undefined
  }
  return budget
}

const applyOpenAICompatibleThinkingBudget = (
  payload: ChatCompletionsPayload,
  source: AnthropicMessagesPayload,
): void => {
  const thinkingBudget = getRequestThinkingBudget(source)
  if (thinkingBudget !== undefined) {
    payload.thinking_budget = thinkingBudget
    return
  }

  if (payload.thinking_budget === undefined) {
    delete payload.thinking_budget
  }
}

const applyOpenAICompatibleExtraBodyThinkingBudget = (
  payload: ChatCompletionsPayload,
  options: { extraBody: Record<string, unknown> | undefined },
): void => {
  const { extraBody } = options
  if (!extraBody || !Object.hasOwn(extraBody, "thinking_budget")) {
    return
  }

  const rawPayload = payload as Record<string, unknown>
  rawPayload.thinking_budget = extraBody.thinking_budget
}

const handleOpenAICompatibleProviderMessages = async (
  c: Context,
  options: {
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { modelConfig, payload, provider, providerConfig } = options
  const openAIPayload = createOpenAICompatiblePayload(
    payload,
    modelConfig,
    providerConfig,
  )
  debugJson(logger, "provider.messages.openai_compatible.request", {
    payload: openAIPayload,
    provider,
  })

  const upstreamResponse = await forwardProviderChatCompletions(
    providerConfig,
    openAIPayload,
    c.req.raw.headers,
  )

  if (!upstreamResponse.ok) {
    logger.error(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
    throw new HTTPError(
      "Failed to create openai-compatible responses",
      upstreamResponse,
    )
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? ""
  const isStreamingResponse =
    Boolean(openAIPayload.stream) && contentType.includes("text/event-stream")

  if (isStreamingResponse) {
    return streamOpenAICompatibleProviderMessages({
      c,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      upstreamResponse,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ChatCompletionResponse
  return respondOpenAICompatibleProviderMessagesJson(c, {
    body: jsonBody,
    modelConfig,
    payload,
    pricingCurrency: providerConfig.pricingCurrency,
    provider,
  })
}

const createOpenAICompatiblePayload = (
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig | undefined,
  providerConfig: ResolvedProviderConfig,
): ChatCompletionsPayload => {
  const openAIPayload = translateToOpenAI(payload, {
    supportPdf: modelConfig?.supportPdf,
    toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
  })

  const isDashScopeProvider = isDashScopeAliyunProvider(providerConfig)

  if (isDashScopeProvider) {
    applyOpenAICompatibleThinkingBudget(openAIPayload, payload)
  } else {
    delete openAIPayload.thinking_budget
  }

  if (payload.top_k !== undefined) {
    openAIPayload.top_k = payload.top_k
  }

  if (openAIPayload.stream) {
    openAIPayload.stream_options = {
      include_usage: true,
    }
  }

  normalizeOpenAICompatibleReasoningContent(openAIPayload)

  applyOpenAICompatibleRequestOverrides(openAIPayload, {
    extraBody: modelConfig?.extraBody,
    source: payload as unknown as Record<string, unknown>,
  })

  applyMissingExtraBody(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyOpenAICompatibleExtraBodyThinkingBudget(openAIPayload, {
    extraBody: modelConfig?.extraBody,
  })

  applyDashScopePreserveThinkingDefault(
    openAIPayload as unknown as Record<string, unknown>,
    providerConfig,
  )

  if (!Object.hasOwn(openAIPayload, "parallel_tool_calls")) {
    openAIPayload.parallel_tool_calls = true
  }

  const contextCacheEnabled = modelConfig?.contextCache ?? isDashScopeProvider
  if (contextCacheEnabled) {
    applyOpenAICompatibleContextCache(openAIPayload)
  }

  return openAIPayload
}

const normalizeOpenAICompatibleReasoningContent = (
  payload: ChatCompletionsPayload,
): void => {
  for (const message of payload.messages) {
    if (message.role !== "assistant") {
      continue
    }

    if (
      message.reasoning_content === undefined
      && message.reasoning_text !== undefined
    ) {
      message.reasoning_content = message.reasoning_text
    }

    delete message.reasoning_text
    delete message.reasoning_opaque
  }
}

const applyOpenAICompatibleRequestOverrides = (
  payload: ChatCompletionsPayload,
  options: {
    extraBody: Record<string, unknown> | undefined
    source: Record<string, unknown>
  },
): void => {
  const allowedKeys = new Set(Object.keys(options.extraBody ?? {}))
  for (const key of allowedKeys) {
    if (Object.hasOwn(options.source, key)) {
      payload[key] = options.source[key]
    }
  }
}

const streamProviderMessages = ({
  c,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}

    for await (const chunk of events(upstreamResponse)) {
      logger.debug("provider.messages.raw_stream_event:", chunk.data)
      const eventName = chunk.event
      if (eventName === "ping") {
        await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
        continue
      }

      let data = chunk.data
      if (!data) {
        continue
      }

      if (chunk.data === "[DONE]") {
        break
      }

      const parsed = parseProviderStreamEvent(data)
      if (parsed) {
        usage = mergeAnthropicUsage(usage, parsed.usage)
        data = parsed.data
      }

      await stream.writeSSE({
        event: eventName,
        data,
      })
    }

    recordUsage(usage)
  })
}

const streamOpenAICompatibleProviderMessages = ({
  c,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  upstreamResponse: Response
}): Response => {
  logger.debug("provider.messages.openai_compatible.streaming")
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
    }
    let terminatedWithError = false

    try {
      for await (const chunk of events(upstreamResponse)) {
        logger.debug(
          "provider.messages.openai_compatible.raw_stream_event:",
          chunk.data,
        )
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        if (chunk.data === "[DONE]") {
          break
        }

        if (!chunk.data && eventName !== "error") {
          continue
        }

        const parsed = parseOpenAICompatibleStreamFrame(
          chunk.data ?? "",
          eventName,
        )
        if (parsed.kind === "skip") {
          continue
        }

        if (parsed.kind === "error") {
          const eventData = JSON.stringify(parsed.event)
          debugLazy(logger, () => [
            "provider.messages.openai_compatible.translated_event:",
            eventData,
          ])
          await stream.writeSSE({
            event: parsed.event.type,
            data: eventData,
          })
          terminatedWithError = true
          break
        }

        if (parsed.chunk.usage) {
          usage = normalizeOpenAIUsage(parsed.chunk.usage)
        }

        const events = translateChunkToAnthropicEvents(
          parsed.chunk,
          streamState,
        )
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => [
            "provider.messages.openai_compatible.translated_event:",
            eventData,
          ])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }

      if (!terminatedWithError) {
        for (const event of flushPendingAnthropicStreamEvents(streamState)) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => [
            "provider.messages.openai_compatible.translated_event:",
            eventData,
          ])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }
    } finally {
      recordUsage(usage)
    }
  })
}

const streamResponsesProviderMessages = ({
  c,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  providerConfig,
  upstreamResponse,
}: {
  c: Context
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  providerConfig: ResolvedProviderConfig
  upstreamResponse: ResponsesStream
}): Response => {
  logger.debug("provider.messages.responses.streaming", {
    provider,
  })
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState = createResponsesStreamState({
      toolSearchName: resolveBridgeToolSearchName(payload.tools),
    })

    try {
      for await (const chunk of upstreamResponse) {
        logger.debug(
          "provider.messages.responses.raw_stream_event:",
          chunk.data,
        )
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        if (chunk.data === "[DONE]") {
          break
        }

        if (!chunk.data) {
          continue
        }

        const parsed = parseResponsesProviderStreamChunk(
          chunk.data,
          providerConfig,
        )
        if (!parsed) {
          continue
        }

        if (
          parsed.type === "response.completed"
          || parsed.type === "response.failed"
          || parsed.type === "response.incomplete"
        ) {
          usage = normalizeResponsesUsage(parsed.response.usage)
        }

        const events = translateResponsesStreamEvent(parsed, streamState)
        for (const event of events) {
          const eventData = JSON.stringify(event)
          debugLazy(logger, () => [
            "provider.messages.responses.translated_event:",
            eventData,
          ])
          await stream.writeSSE({
            event: event.type,
            data: eventData,
          })
        }
      }

      if (!streamState.messageCompleted) {
        const errorEvent = buildErrorEvent(
          `${provider} stream ended without a completion event`,
        )
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    } finally {
      recordUsage(usage)
    }
  })
}

const isResponsesStream = (value: unknown): value is ResponsesStream => {
  return (
    Boolean(value)
    && typeof (value as ResponsesStream)[Symbol.asyncIterator] === "function"
  )
}

type OpenAICompatibleStreamFrame =
  | { kind: "chunk"; chunk: ChatCompletionChunk }
  | { kind: "error"; event: AnthropicStreamEventData }
  | { kind: "skip" }

const parseOpenAICompatibleStreamFrame = (
  data: string,
  eventName: string | undefined,
): OpenAICompatibleStreamFrame => {
  if (eventName === "error") {
    return {
      kind: "error",
      event: createOpenAICompatibleStreamErrorEventFromData(data),
    }
  }

  try {
    const parsed: unknown = JSON.parse(data)
    if (isOpenAICompatibleStreamChunk(parsed)) {
      return { kind: "chunk", chunk: parsed }
    }

    const errorEvent = createOpenAICompatibleStreamErrorEvent(parsed, eventName)
    if (errorEvent) {
      return { kind: "error", event: errorEvent }
    }

    logger.error("provider.messages.openai_compatible.invalid_chunk", {
      data: parsed,
      eventName,
    })
    return { kind: "skip" }
  } catch (error) {
    logger.error("provider.messages.openai_compatible.parse_chunk_error", {
      data,
      error,
    })
    return { kind: "skip" }
  }
}

const createOpenAICompatibleStreamErrorEventFromData = (
  data: string,
): AnthropicStreamEventData => {
  try {
    const parsed: unknown = JSON.parse(data)
    return (
      createOpenAICompatibleStreamErrorEvent(parsed, "error")
      ?? createAnthropicStreamErrorEvent({
        message: "Upstream provider stream returned an error event.",
        type: "api_error",
      })
    )
  } catch {
    return createAnthropicStreamErrorEvent({
      message: data || "Upstream provider stream returned an error event.",
      type: "api_error",
    })
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isOpenAICompatibleStreamChunk = (
  value: unknown,
): value is ChatCompletionChunk =>
  isRecord(value) && Array.isArray(value.choices)

const createOpenAICompatibleStreamErrorEvent = (
  value: unknown,
  eventName: string | undefined,
): AnthropicStreamEventData | null => {
  if (!isRecord(value) && eventName !== "error") {
    return null
  }

  const errorPayload = isRecord(value) ? value.error : undefined
  if (isRecord(errorPayload)) {
    return createAnthropicStreamErrorEvent({
      message:
        typeof errorPayload.message === "string" ?
          errorPayload.message
        : "Upstream provider stream failed.",
      type:
        typeof errorPayload.type === "string" ? errorPayload.type : "api_error",
    })
  }

  if (typeof errorPayload === "string") {
    return createAnthropicStreamErrorEvent({
      message: errorPayload,
      type: "api_error",
    })
  }

  if (isRecord(value) && typeof value.message === "string") {
    return createAnthropicStreamErrorEvent({
      message: value.message,
      type:
        typeof value.type === "string" && value.type !== "error" ?
          value.type
        : "api_error",
    })
  }

  if (isRecord(value) && value.type === "error") {
    return createAnthropicStreamErrorEvent({
      message:
        typeof value.message === "string" ?
          value.message
        : "Upstream provider stream failed.",
      type: "api_error",
    })
  }

  if (typeof value === "string" && eventName === "error") {
    return createAnthropicStreamErrorEvent({
      message: value,
      type: "api_error",
    })
  }

  if (eventName === "error") {
    return createAnthropicStreamErrorEvent({
      message: "Upstream provider stream returned an error event.",
      type: "api_error",
    })
  }

  return null
}

const createAnthropicStreamErrorEvent = ({
  message,
  type,
}: {
  message: string
  type: string
}): AnthropicStreamEventData => ({
  type: "error",
  error: {
    type,
    message,
  },
})

const parseResponsesProviderStreamChunk = (
  data: string,
  providerConfig: ResolvedProviderConfig,
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

const parseProviderStreamEvent = (
  data: string,
): { data: string; model?: string; usage: UsageTokens } | null => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "message_start") {
      return {
        data: JSON.stringify(parsed),
        model: parsed.message.model,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
      return {
        data: JSON.stringify(parsed),
        usage: normalizeAnthropicUsage(parsed.usage),
      }
    }
    return { data: JSON.stringify(parsed), usage: {} }
  } catch (error) {
    logger.error("provider.messages.streaming.adjust_tokens_error", {
      error,
      originalData: data,
    })
    return null
  }
}

const respondProviderMessagesJson = (
  c: Context,
  options: {
    body: AnthropicResponse
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
  },
): Response => {
  const { body, modelConfig, payload, pricingCurrency, provider } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  recordUsage(normalizeAnthropicUsage(body.usage))

  debugJson(logger, "provider.messages.no_stream result:", body)
  return c.json(body)
}

const respondOpenAICompatibleProviderMessagesJson = (
  c: Context,
  options: {
    body: ChatCompletionResponse
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
  },
): Response => {
  const { body, modelConfig, payload, pricingCurrency, provider } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  recordUsage(normalizeOpenAIUsage(body.usage))

  const anthropicResponse = translateToAnthropic(body)
  debugJson(
    logger,
    "provider.messages.openai_compatible.no_stream result:",
    anthropicResponse,
  )
  return c.json(anthropicResponse)
}

const respondResponsesProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Response => {
  const {
    body,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
    providerConfig,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  recordUsage(normalizeResponsesUsage(body.usage))

  const anthropicResponse = translateResponsesResultToAnthropic(body, {
    toolSearchName: resolveBridgeToolSearchName(payload.tools),
  })
  debugJson(
    logger,
    "provider.messages.responses.no_stream result:",
    anthropicResponse,
  )

  if (providerConfig.name === "codex") {
    logger.debug("provider.messages.codex.no_stream.result")
  }
  return c.json(anthropicResponse)
}

const respondWebSearchProviderMessagesJson = (
  c: Context,
  options: {
    body: ResponsesResult
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
  },
): Response => {
  const { body, modelConfig, payload, pricingCurrency, provider } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
  )
  recordUsage(normalizeResponsesUsage(body.usage))

  const { extract, response } = reconstructWebSearchResponse(payload, body, {
    requestId: body.id || `${provider}:${payload.model}`,
  })

  debugJson(
    logger,
    `Web search via responses: ${extract.queries.length} quer(y/ies), ${extract.sources.length} source(s)`,
    body,
  )

  if (!payload.stream) {
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    for (const event of buildSyntheticStreamEvents(response)) {
      const data = JSON.stringify(event)
      logger.debug(`Web search stream event`, data)
      await stream.writeSSE({
        event: event.type,
        data: data,
      })
    }
  })
}

const createProviderMessagesUsageRecorder = (
  payload: AnthropicMessagesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
) =>
  createProviderTokenUsageRecorder({
    endpoint: "provider_messages",
    model: payload.model,
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
    sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
  })
