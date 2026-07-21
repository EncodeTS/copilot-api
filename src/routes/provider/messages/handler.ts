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
  ResponsesPayload,
  ResponsesResult,
  ResponsesStream,
} from "~/services/copilot/create-responses"
import type { Model } from "~/services/copilot/get-models"

import {
  getModelResponsesApiCompactThreshold,
  isContextManagementEnabledForMessages,
  type ModelConfig,
  type ResolvedProviderConfig,
  supportsProviderResponsesContextManagement,
} from "~/lib/config"
import {
  applyDashScopePreserveThinkingDefault,
  applyOpenAICompatibleContextCache,
  isDashScopeAliyunProvider,
} from "~/lib/dashscope"
import { HTTPError } from "~/lib/error"
import {
  createHandlerLogger,
  debugJson,
  debugJsonTail,
  debugLazy,
} from "~/lib/logger"
import {
  resolveProviderConfig,
  resolveProviderModel,
  type ProviderResolverPort,
} from "~/lib/provider-resolver"
import { normalizeMessageReasoningEffort } from "~/lib/reasoning-effort"
import type { StreamTransport } from "~/lib/stream-lifecycle"
import { resolveBridgeToolSearchName } from "~/lib/tool-search"
import {
  createProviderTokenUsageRecorder,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  normalizeResponsesUsage,
  type TokenUsageRecorder,
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
  collectProviderResponsesStreamResult,
  consumeResponsesStream,
} from "~/routes/messages/responses-stream-consumer"
import { getResponsesResultFailureMessage } from "~/routes/messages/responses-result"
import {
  hasTrailingAssistantPrefill,
  translateAnthropicMessagesToResponsesPayload,
  translateResponsesResultToAnthropic,
} from "~/routes/messages/responses-translation"
import {
  applyWebSearchFallbackHeaders,
  applyWebSearchReasoningEffort,
  buildSyntheticStreamEvents,
  createWebSearchUnsupportedResponse,
  getWebSearchUsageMetadata,
  hasWebSearchServerTool,
  isWebSearchOnlyRequest,
  normalizeWebSearchResponsesUsage,
  prepareWebSearchResponsesPayload,
  reconstructWebSearchResponse,
  WEB_SEARCH_PROVIDER_ADAPTER_UNSUPPORTED_MESSAGE,
} from "~/routes/messages/web-search/fulfill"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"
import {
  applyResponsesApiContextManagement,
  compactInputByLatestCompaction,
} from "~/routes/responses/utils"
import {
  forwardCodexResponses,
  resolveCodexResponsesTransport,
} from "~/services/codex/create-responses"
import {
  getCodexProviderCatalogHeaders,
  loadCodexProviderModels,
} from "~/services/codex/get-models"
import {
  forwardProviderChatCompletions,
  forwardProviderMessages,
  forwardProviderResponses,
} from "~/services/providers/provider-proxy"

const logger = createHandlerLogger("provider-messages-handler")

export interface ProviderMessagesHandler {
  handle: (c: Context<Env, "/:provider">) => Promise<Response>
  handleForProvider: (
    c: Context,
    options: {
      payload: AnthropicMessagesPayload
      provider: string
    },
  ) => Promise<Response>
}

export interface ProviderMessagesComposition {
  createProviderTokenUsageRecorder?: typeof createProviderTokenUsageRecorder
  forwardCodexResponses?: typeof forwardCodexResponses
  getModelResponsesApiCompactThreshold?: typeof getModelResponsesApiCompactThreshold
  isContextManagementEnabledForMessages?: typeof isContextManagementEnabledForMessages
  loadCodexProviderModels?: typeof loadCodexProviderModels
  providerResolver?: ProviderResolverPort
  resolveCodexResponsesTransport?: typeof resolveCodexResponsesTransport
}

interface ProviderMessagesDependencies {
  createProviderTokenUsageRecorder: typeof createProviderTokenUsageRecorder
  forwardCodexResponses: typeof forwardCodexResponses
  getModelResponsesApiCompactThreshold: typeof getModelResponsesApiCompactThreshold
  isContextManagementEnabledForMessages: typeof isContextManagementEnabledForMessages
  loadCodexProviderModels: typeof loadCodexProviderModels
  providerResolver: ProviderResolverPort
  resolveCodexResponsesTransport: typeof resolveCodexResponsesTransport
}

const createDefaultProviderMessagesDependencies =
  (): ProviderMessagesDependencies => ({
    createProviderTokenUsageRecorder,
    forwardCodexResponses,
    getModelResponsesApiCompactThreshold,
    isContextManagementEnabledForMessages,
    loadCodexProviderModels,
    providerResolver: {
      resolveConfig: resolveProviderConfig,
      resolveModel: resolveProviderModel,
    },
    resolveCodexResponsesTransport,
  })

export const createProviderMessagesHandler = (
  composition: ProviderMessagesComposition = {},
): ProviderMessagesHandler => {
  const dependencies = Object.freeze<ProviderMessagesDependencies>({
    createProviderTokenUsageRecorder:
      composition.createProviderTokenUsageRecorder
      ?? createProviderTokenUsageRecorder,
    forwardCodexResponses:
      composition.forwardCodexResponses ?? forwardCodexResponses,
    getModelResponsesApiCompactThreshold:
      composition.getModelResponsesApiCompactThreshold
      ?? getModelResponsesApiCompactThreshold,
    isContextManagementEnabledForMessages:
      composition.isContextManagementEnabledForMessages
      ?? isContextManagementEnabledForMessages,
    loadCodexProviderModels:
      composition.loadCodexProviderModels ?? loadCodexProviderModels,
    providerResolver: Object.freeze({
      ...(composition.providerResolver
        ?? createDefaultProviderMessagesDependencies().providerResolver),
    }),
    resolveCodexResponsesTransport:
      composition.resolveCodexResponsesTransport
      ?? resolveCodexResponsesTransport,
  })

  const handler: ProviderMessagesHandler = {
    handle: (c) => handleProviderMessagesWithDependencies(c, dependencies),
    handleForProvider: (c, options) =>
      handleProviderMessagesForProviderWithDependencies(
        c,
        options,
        dependencies,
      ),
  }
  return Object.freeze(handler)
}

const applyCodexProviderReasoningEffort = (
  source: AnthropicMessagesPayload,
  target: ResponsesPayload,
  selectedModel: Model | undefined,
): string | null => {
  const outputConfig: unknown = source.output_config
  const disabled = source.thinking?.type === "disabled"
  if (
    !disabled
    && (!isRecord(outputConfig) || !Object.hasOwn(outputConfig, "effort"))
  ) {
    if (target.reasoning) {
      delete target.reasoning.effort
    }
    return null
  }

  const effort =
    disabled ? "none"
    : isRecord(outputConfig) ?
      normalizeMessageReasoningEffort(outputConfig.effort)
    : null
  if (!effort) {
    return "Invalid Codex reasoning effort"
  }
  if (!selectedModel) {
    return `Cannot validate reasoning effort for unavailable Codex model '${source.model}'`
  }
  if (!selectedModel.capabilities.supports.reasoning_effort?.includes(effort)) {
    return `Reasoning effort '${effort}' is not supported by Codex model '${source.model}'`
  }

  target.reasoning = { ...target.reasoning, effort }
  return null
}

const codexReasoningError = (c: Context, message: string): Response =>
  c.json(
    {
      error: {
        message,
        type: "invalid_request_error",
      },
    },
    400,
  )

export async function handleProviderMessages(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  return await handleProviderMessagesWithDependencies(
    c,
    createDefaultProviderMessagesDependencies(),
  )
}

async function handleProviderMessagesWithDependencies(
  c: Context<Env, "/:provider">,
  dependencies: ProviderMessagesDependencies,
): Promise<Response> {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderMessagesForProviderWithDependencies(
    c,
    { payload, provider },
    dependencies,
  )
}

export async function handleProviderMessagesForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  return await handleProviderMessagesForProviderWithDependencies(
    c,
    options,
    createDefaultProviderMessagesDependencies(),
  )
}

async function handleProviderMessagesForProviderWithDependencies(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
  dependencies: ProviderMessagesDependencies,
): Promise<Response> {
  const { payload, provider } = options
  const resolvedProviderModel =
    await dependencies.providerResolver.resolveModel(provider, payload.model, {
      signal: c.req.raw.signal,
    })
  if (!resolvedProviderModel) {
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
    const {
      config: providerConfig,
      forwardingConfig,
      modelConfig,
      type: effectiveType,
    } = resolvedProviderModel
    debugJson(logger, "provider.messages.request", { payload, provider })

    normalizeSystemMessages(payload)

    applyModelDefaults(payload, modelConfig)

    if (effectiveType === "openai-responses") {
      if (hasTrailingAssistantPrefill(payload)) {
        return c.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "Assistant prefill is not supported by the Responses API bridge.",
            },
          },
          400,
        )
      }

      const codexCatalog =
        forwardingConfig.name === "codex" ?
          await dependencies.loadCodexProviderModels(c.req.raw.signal)
        : undefined
      if (codexCatalog) {
        for (const [name, value] of Object.entries(
          getCodexProviderCatalogHeaders(codexCatalog),
        )) {
          c.header(name, value)
        }
      }
      const selectedCodexModel = codexCatalog?.catalog.data.find(
        (model) => model.id === payload.model,
      )

      if (hasWebSearchServerTool(payload)) {
        if (isWebSearchOnlyRequest(payload)) {
          return await handleOpenAIResponsesProviderWebSearchMessages(c, {
            dependencies,
            modelConfig,
            payload,
            provider,
            providerConfig: forwardingConfig,
            selectedCodexModel,
          })
        }
        return createWebSearchUnsupportedResponse(c)
      }

      return await handleOpenAIResponsesProviderMessages(c, {
        dependencies,
        modelConfig,
        payload,
        provider,
        providerConfig: forwardingConfig,
        selectedCodexModel,
      })
    }

    if (effectiveType === "openai-compatible") {
      if (hasWebSearchServerTool(payload)) {
        return createWebSearchUnsupportedResponse(
          c,
          isWebSearchOnlyRequest(payload) ?
            WEB_SEARCH_PROVIDER_ADAPTER_UNSUPPORTED_MESSAGE
          : undefined,
        )
      }

      return await handleOpenAICompatibleProviderMessages(c, {
        dependencies,
        modelConfig,
        payload,
        provider,
        providerConfig: forwardingConfig,
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
      forwardingConfig,
      payload,
      c.req.raw.headers,
      c.req.raw.signal,
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
        dependencies,
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
      dependencies,
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
    dependencies: ProviderMessagesDependencies
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    selectedCodexModel?: Model
  },
): Promise<Response> => {
  const {
    dependencies,
    modelConfig,
    payload,
    provider,
    providerConfig,
    selectedCodexModel,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
    dependencies,
  )
  applyWebSearchFallbackHeaders(c, payload, logger)
  const responsesPayload = prepareWebSearchResponsesPayload(payload)
  const reasoningError =
    providerConfig.name === "codex" ?
      applyCodexProviderReasoningEffort(
        payload,
        responsesPayload,
        selectedCodexModel,
      )
    : applyWebSearchReasoningEffort(payload, responsesPayload, undefined)
  if (reasoningError) {
    return codexReasoningError(c, reasoningError)
  }

  debugJson(logger, "provider.messages.responses.web_search.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const upstreamResponse = await dependencies.forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: c.req.raw.signal },
    )

    if (isResponsesStream(upstreamResponse)) {
      const body = await collectProviderResponsesStreamResult({
        errorMessagePrefix: `${provider} web search responses stream`,
        logger,
        providerConfig,
        recordUsage,
        upstreamResponse,
      })
      return respondWebSearchProviderMessagesJson(c, {
        body,
        payload,
        provider,
        recordUsage,
      })
    }

    return respondWebSearchProviderMessagesJson(c, {
      body: upstreamResponse,
      payload,
      provider,
      recordUsage,
    })
  }

  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
    c.req.raw.signal,
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
    const body = await collectProviderResponsesStreamResult({
      errorMessagePrefix: `${provider} web search responses stream`,
      logger,
      providerConfig,
      recordUsage,
      upstreamResponse: events(upstreamResponse),
    })
    return respondWebSearchProviderMessagesJson(c, {
      body,
      payload,
      provider,
      recordUsage,
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondWebSearchProviderMessagesJson(c, {
    body: jsonBody,
    payload,
    provider,
    recordUsage,
  })
}

const handleOpenAIResponsesProviderMessages = async (
  c: Context,
  options: {
    dependencies: ProviderMessagesDependencies
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    selectedCodexModel?: Model
  },
): Promise<Response> => {
  const {
    dependencies,
    modelConfig,
    payload,
    provider,
    providerConfig,
    selectedCodexModel,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    providerConfig.pricingCurrency,
    dependencies,
  )
  const wantsStream = payload.stream === true
  const responsesPayload = translateAnthropicMessagesToResponsesPayload(
    payload,
    undefined,
    { model: payload.model, provider },
  )
  const reasoningError =
    providerConfig.name === "codex" ?
      applyCodexProviderReasoningEffort(
        payload,
        responsesPayload,
        selectedCodexModel,
      )
    : null
  if (reasoningError) {
    return codexReasoningError(c, reasoningError)
  }

  if (providerConfig.name === "codex" && !wantsStream) {
    responsesPayload.stream = true
  }

  if (
    supportsProviderResponsesContextManagement(
      providerConfig,
      responsesPayload.model,
    )
  ) {
    const contextManagementDecision = applyResponsesApiContextManagement(
      responsesPayload,
      selectedCodexModel?.capabilities.limits,
      {
        contextManagementEnabled:
          dependencies.isContextManagementEnabledForMessages(),
        modelCompactThreshold:
          dependencies.getModelResponsesApiCompactThreshold(
            responsesPayload.model,
          ) ?? null,
        source: "messages",
      },
    )
    if (contextManagementDecision.shouldPruneInput) {
      compactInputByLatestCompaction(responsesPayload)
    }
  }

  debugJson(logger, "provider.messages.responses.request", {
    payload: responsesPayload,
    provider,
  })

  if (providerConfig.name === "codex") {
    const transport = dependencies.resolveCodexResponsesTransport()
    const streamControl =
      wantsStream && transport === "http" ?
        createProviderResponsesStreamControl(c.req.raw.signal)
      : undefined
    const upstreamSignal = streamControl?.signal ?? c.req.raw.signal
    const upstreamResponse = await dependencies.forwardCodexResponses(
      responsesPayload,
      c.req.raw.headers,
      providerConfig.baseUrl,
      { signal: upstreamSignal, transport },
    )

    if (isResponsesStream(upstreamResponse)) {
      if (wantsStream) {
        return streamResponsesProviderMessages({
          c,
          dependencies,
          modelConfig,
          payload,
          pricingCurrency: providerConfig.pricingCurrency,
          provider,
          providerConfig,
          releaseUpstream: streamControl?.release,
          signal: upstreamSignal,
          transport,
          upstreamResponse,
        })
      }

      const body = await collectProviderResponsesStreamResult({
        errorMessagePrefix: `${provider} messages responses stream`,
        logger,
        providerConfig,
        recordUsage,
        upstreamResponse,
      })
      return respondResponsesProviderMessagesJson(c, {
        body,
        payload,
        provider,
        providerConfig,
        recordUsage,
      })
    }

    return respondResponsesProviderMessagesJson(c, {
      body: upstreamResponse,
      payload,
      provider,
      providerConfig,
      recordUsage,
    })
  }

  const streamControl =
    responsesPayload.stream ?
      createProviderResponsesStreamControl(c.req.raw.signal)
    : undefined
  const upstreamSignal = streamControl?.signal ?? c.req.raw.signal
  const upstreamResponse = await forwardProviderResponses(
    providerConfig,
    responsesPayload,
    c.req.raw.headers,
    upstreamSignal,
  )

  if (!upstreamResponse.ok) {
    logger.error("Failed to create provider responses", upstreamResponse)
    throw new HTTPError("Failed to create provider responses", upstreamResponse)
  }

  if (responsesPayload.stream) {
    return streamResponsesProviderMessages({
      c,
      dependencies,
      modelConfig,
      payload,
      pricingCurrency: providerConfig.pricingCurrency,
      provider,
      providerConfig,
      releaseUpstream: streamControl?.release,
      signal: upstreamSignal,
      transport: "http",
      upstreamResponse: events(upstreamResponse, upstreamSignal),
    })
  }

  const jsonBody = (await upstreamResponse.json()) as ResponsesResult
  return respondResponsesProviderMessagesJson(c, {
    body: jsonBody,
    payload,
    provider,
    providerConfig,
    recordUsage,
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
    dependencies: ProviderMessagesDependencies
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
  },
): Promise<Response> => {
  const { dependencies, modelConfig, payload, provider, providerConfig } =
    options
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
    c.req.raw.signal,
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
      dependencies,
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
    dependencies,
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
  dependencies,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
}: {
  c: Context
  dependencies: ProviderMessagesDependencies
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
    dependencies,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    let terminalSeen = false

    try {
      for await (const chunk of events(upstreamResponse)) {
        debugJsonTail(logger, "provider.messages.raw_stream_event:", {
          value: chunk.data,
          tailLength: 1_000,
        })
        const eventName = chunk.event
        if (eventName === "ping") {
          await stream.writeSSE({ event: "ping", data: '{"type":"ping"}' })
          continue
        }

        let data = chunk.data
        if (!data) {
          continue
        }

        terminalSeen ||= eventName === "error"

        if (chunk.data === "[DONE]") {
          break
        }

        const parsed = parseProviderStreamEvent(data)
        if (parsed) {
          usage = mergeAnthropicUsage(usage, parsed.usage)
          data = parsed.data
          terminalSeen ||=
            parsed.type === "message_stop" || parsed.type === "error"
        }

        await stream.writeSSE({
          event: eventName,
          data,
        })

        if (terminalSeen) {
          break
        }
      }

      if (!terminalSeen) {
        const errorEvent = createAnthropicStreamErrorEvent({
          message: "Provider Anthropic stream ended without message_stop",
          type: "api_error",
        })
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
      }
    } catch (error) {
      if (!terminalSeen) {
        const errorEvent = createAnthropicStreamErrorEvent({
          message: `Provider Anthropic stream failed: ${getProviderStreamErrorMessage(error)}`,
          type: "api_error",
        })
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

const streamOpenAICompatibleProviderMessages = ({
  c,
  dependencies,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  upstreamResponse,
}: {
  c: Context
  dependencies: ProviderMessagesDependencies
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
    dependencies,
  )
  return streamSSE(c, async (stream) => {
    let usage: UsageTokens = {}
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
      thinkingBlockOpen: false,
      emitThinking: payload.thinking?.type !== "disabled",
    }
    let terminatedWithError = false
    let terminalSeen = false

    try {
      for await (const chunk of events(upstreamResponse)) {
        debugJsonTail(
          logger,
          "provider.messages.openai_compatible.raw_stream_event:",
          {
            value: chunk.data,
            tailLength: 1_000,
          },
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

        if (
          parsed.chunk.choices.some(
            (choice) => choice.finish_reason === "error",
          )
        ) {
          const errorEvent = createAnthropicStreamErrorEvent({
            message: "Provider upstream ended with finish_reason=error",
            type: "api_error",
          })
          await stream.writeSSE({
            event: errorEvent.type,
            data: JSON.stringify(errorEvent),
          })
          terminalSeen = true
          terminatedWithError = true
          break
        }

        terminalSeen ||= parsed.chunk.choices.some((choice) =>
          Boolean(choice.finish_reason),
        )

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

      if (!terminatedWithError && !terminalSeen) {
        const errorEvent = createAnthropicStreamErrorEvent({
          message:
            "Provider OpenAI-compatible stream ended without finish_reason",
          type: "api_error",
        })
        await stream.writeSSE({
          event: errorEvent.type,
          data: JSON.stringify(errorEvent),
        })
        terminatedWithError = true
      }

      if (!terminatedWithError && terminalSeen) {
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
    } catch (error) {
      if (!terminatedWithError) {
        const errorEvent = createAnthropicStreamErrorEvent({
          message: `Provider OpenAI-compatible stream failed: ${getProviderStreamErrorMessage(error)}`,
          type: "api_error",
        })
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

const streamResponsesProviderMessages = ({
  c,
  dependencies,
  modelConfig,
  payload,
  pricingCurrency,
  provider,
  providerConfig,
  releaseUpstream,
  signal,
  transport,
  upstreamResponse,
}: {
  c: Context
  dependencies: ProviderMessagesDependencies
  modelConfig: ModelConfig | undefined
  payload: AnthropicMessagesPayload
  pricingCurrency: string | undefined
  provider: string
  providerConfig: ResolvedProviderConfig
  releaseUpstream?: (reason: unknown) => Promise<void> | void
  signal: AbortSignal
  transport: StreamTransport
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
    dependencies,
  )
  return streamSSE(c, (stream) =>
    consumeResponsesStream({
      kind: "provider",
      logger,
      output: stream,
      payload,
      provider,
      providerConfig,
      recordUsage,
      releaseUpstream,
      signal,
      transport,
      upstreamResponse,
    }),
  )
}

const createProviderResponsesStreamControl = (
  callerSignal: AbortSignal,
): {
  release: (reason: unknown) => void
  signal: AbortSignal
} => {
  const controller = new AbortController()
  return {
    release: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason)
      }
    },
    signal: AbortSignal.any([callerSignal, controller.signal]),
  }
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

const getProviderStreamErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const parseProviderStreamEvent = (
  data: string,
): {
  data: string
  model?: string
  type: string
  usage: UsageTokens
} | null => {
  try {
    const parsed = JSON.parse(data) as AnthropicStreamEventData
    if (parsed.type === "message_start") {
      return {
        data: JSON.stringify(parsed),
        model: parsed.message.model,
        type: parsed.type,
        usage: normalizeAnthropicUsage(parsed.message.usage),
      }
    }
    if (parsed.type === "message_delta") {
      return {
        data: JSON.stringify(parsed),
        type: parsed.type,
        usage: normalizeAnthropicUsage(parsed.usage),
      }
    }
    return { data: JSON.stringify(parsed), type: parsed.type, usage: {} }
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
    dependencies: ProviderMessagesDependencies
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
  },
): Response => {
  const {
    body,
    dependencies,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    dependencies,
  )
  recordUsage(normalizeAnthropicUsage(body.usage))

  debugJson(logger, "provider.messages.no_stream result:", body)
  return c.json(body)
}

const respondOpenAICompatibleProviderMessagesJson = (
  c: Context,
  options: {
    body: ChatCompletionResponse
    dependencies: ProviderMessagesDependencies
    modelConfig: ModelConfig | undefined
    payload: AnthropicMessagesPayload
    pricingCurrency: string | undefined
    provider: string
  },
): Response => {
  const {
    body,
    dependencies,
    modelConfig,
    payload,
    pricingCurrency,
    provider,
  } = options
  const recordUsage = createProviderMessagesUsageRecorder(
    payload,
    provider,
    modelConfig,
    pricingCurrency,
    dependencies,
  )
  recordUsage(normalizeOpenAIUsage(body.usage))

  if (body.choices.some((choice) => choice.finish_reason === "error")) {
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: "Provider upstream ended with finish_reason=error",
        },
      },
      502,
    )
  }

  const anthropicResponse = translateToAnthropic(body, {
    includeThinking: payload.thinking?.type !== "disabled",
  })
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
    payload: AnthropicMessagesPayload
    provider: string
    providerConfig: ResolvedProviderConfig
    recordUsage: TokenUsageRecorder
  },
): Response => {
  const { body, payload, provider, providerConfig, recordUsage } = options

  const failureMessage = recordProviderResponsesResultUsage(recordUsage, body)
  if (failureMessage) {
    return c.json(
      {
        type: "error",
        error: {
          type: "api_error",
          message: failureMessage,
        },
      },
      502,
    )
  }

  const anthropicResponse = translateResponsesResultToAnthropic(body, {
    carrierSource: { model: payload.model, provider },
    includeThinking: payload.thinking?.type !== "disabled",
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
    payload: AnthropicMessagesPayload
    provider: string
    recordUsage: TokenUsageRecorder
  },
): Response => {
  const { body, payload, provider, recordUsage } = options
  const usage = normalizeWebSearchResponsesUsage(body)
  let reconstructed: ReturnType<typeof reconstructWebSearchResponse>
  try {
    reconstructed = reconstructWebSearchResponse(payload, body, {
      requestId: body.id || `${provider}:${payload.model}`,
    })
  } catch (error) {
    recordUsage(usage, getWebSearchUsageMetadata(body, "rejected"))
    throw error
  }
  recordUsage(usage, getWebSearchUsageMetadata(body, "mapped"))
  const { extract, response } = reconstructed

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

const recordProviderResponsesResultUsage = (
  recordUsage: TokenUsageRecorder,
  body: ResponsesResult,
): string | undefined => {
  const failureMessage = getResponsesResultFailureMessage(body)
  recordUsage(
    normalizeResponsesUsage(body.usage),
    failureMessage ?
      {
        errorCode: "response_failed",
        outcome: "failed",
        terminal: "response.failed",
      }
    : undefined,
  )
  return failureMessage
}

const createProviderMessagesUsageRecorder = (
  payload: AnthropicMessagesPayload,
  provider: string,
  modelConfig: ModelConfig | undefined,
  pricingCurrency: string | undefined,
  dependencies: ProviderMessagesDependencies,
): TokenUsageRecorder =>
  dependencies.createProviderTokenUsageRecorder({
    endpoint: "provider_messages",
    model: payload.model,
    outcome: "completed",
    pricing: modelConfig?.pricing,
    pricingCurrency,
    providerName: provider,
    sessionId: parseUserIdMetadata(payload.metadata?.user_id).sessionId,
  })
