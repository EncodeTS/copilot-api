import type { Context, Env } from "hono"

import { createHandlerLogger } from "~/lib/logger"
import {
  resolveProviderConfig,
  resolveProviderModel,
  type ProviderResolverPort,
} from "~/lib/provider-resolver"
import { createFallbackModel } from "~/lib/provider-model"
import { getTokenCount as getTokenCountDefault } from "~/lib/tokenizer"
import { type AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"
import { translateToOpenAI } from "~/routes/messages/non-stream-translation"
import { normalizeSystemMessages } from "~/routes/messages/preprocess"
import { createMessagesInvalidRequestError } from "~/routes/messages/invalid-request-error"
import {
  createProviderWebSearchCarrierContext,
  webSearchCarrierSanitizer,
} from "~/routes/messages/web-search/carrier-sanitizer"

const logger = createHandlerLogger("provider-count-tokens-handler")

export interface ProviderCountTokensHandler {
  handle: (c: Context<Env, "/:provider">) => Promise<Response>
  handleForProvider: (
    c: Context,
    options: {
      payload: AnthropicMessagesPayload
      provider: string
    },
  ) => Promise<Response>
}

export interface ProviderCountTokensComposition {
  getTokenCount?: typeof getTokenCountDefault
  providerResolver?: ProviderResolverPort
}

interface ProviderCountTokensDependencies {
  getTokenCount: typeof getTokenCountDefault
  providerResolver: ProviderResolverPort
}

const createDefaultProviderCountTokensDependencies =
  (): ProviderCountTokensDependencies => ({
    getTokenCount: getTokenCountDefault,
    providerResolver: {
      resolveConfig: resolveProviderConfig,
      resolveModel: resolveProviderModel,
    },
  })

export const createProviderCountTokensHandler = (
  composition: ProviderCountTokensComposition = {},
): ProviderCountTokensHandler => {
  const defaults = createDefaultProviderCountTokensDependencies()
  const dependencies = Object.freeze<ProviderCountTokensDependencies>({
    getTokenCount: composition.getTokenCount ?? defaults.getTokenCount,
    providerResolver: Object.freeze({
      ...(composition.providerResolver ?? defaults.providerResolver),
    }),
  })
  const handler: ProviderCountTokensHandler = {
    handle: (c) => handleProviderCountTokensWithDependencies(c, dependencies),
    handleForProvider: (c, options) =>
      handleProviderCountTokensForProviderWithDependencies(
        c,
        options,
        dependencies,
      ),
  }
  return Object.freeze(handler)
}

export async function handleProviderCountTokens(
  c: Context<Env, "/:provider">,
): Promise<Response> {
  return await handleProviderCountTokensWithDependencies(
    c,
    createDefaultProviderCountTokensDependencies(),
  )
}

const handleProviderCountTokensWithDependencies = async (
  c: Context<Env, "/:provider">,
  dependencies: ProviderCountTokensDependencies,
): Promise<Response> => {
  const provider = c.req.param("provider")
  const payload = await c.req.json<AnthropicMessagesPayload>()
  return await handleProviderCountTokensForProviderWithDependencies(
    c,
    { payload, provider },
    dependencies,
  )
}

export async function handleProviderCountTokensForProvider(
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
): Promise<Response> {
  return await handleProviderCountTokensForProviderWithDependencies(
    c,
    options,
    createDefaultProviderCountTokensDependencies(),
  )
}

const handleProviderCountTokensForProviderWithDependencies = async (
  c: Context,
  options: {
    payload: AnthropicMessagesPayload
    provider: string
  },
  dependencies: ProviderCountTokensDependencies,
): Promise<Response> => {
  const { payload: anthropicPayload, provider } = options
  normalizeSystemMessages(anthropicPayload)
  const modelId = anthropicPayload.model.trim()

  const resolvedProviderModel =
    await dependencies.providerResolver.resolveModel(provider, modelId, {
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

  const { forwardingConfig, modelConfig, type } = resolvedProviderModel
  const carrierSanitization = webSearchCarrierSanitizer.sanitize(
    anthropicPayload,
    createProviderWebSearchCarrierContext(
      type,
      forwardingConfig.name,
      anthropicPayload.model,
    ),
  )
  if (carrierSanitization.restoredTurns.length > 0) {
    throw createMessagesInvalidRequestError(
      "Resumable Web Search history is not supported by provider token counting.",
    )
  }
  const translationOptions =
    type === "openai-compatible" || type === "openai-responses" ?
      {
        supportPdf: modelConfig?.supportPdf,
        toolContentSupportType: modelConfig?.toolContentSupportType ?? [],
      }
    : undefined

  const openAIPayload = translateToOpenAI(anthropicPayload, translationOptions)

  const selectedModel = createFallbackModel(modelId)

  const tokenCount = await dependencies.getTokenCount(
    openAIPayload,
    selectedModel,
    {
      signal: c.req.raw.signal,
    },
  )
  const finalTokenCount = tokenCount.input + tokenCount.output

  logger.debug("provider.count_tokens.success", {
    provider,
    model: anthropicPayload.model,
    input_tokens: finalTokenCount,
  })

  c.header("x-copilot-api-token-count-mode", "estimate")
  return c.json({
    input_tokens: finalTokenCount,
  })
}
